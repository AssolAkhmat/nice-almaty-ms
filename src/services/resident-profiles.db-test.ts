import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { listAuditEntries } from '@/db/repositories/audit-log';
import { NotFoundError } from '@/lib/errors';

import { AUDIT_ACTIONS } from './audit';
import { readProfile, revealSensitiveField, saveProfile } from './resident-profiles';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';

const url = testDatabaseUrl();
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

beforeAll(() => {
  // Ключ шифрования полей читается из окружения; в тестах он тестовый.
  process.env.FIELD_ENCRYPTION_KEY ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  process.env.DEPLOY_TARGET ??= 'docker';
  process.env.DATABASE_URL ??= url;
  process.env.APP_URL ??= 'http://localhost:3000';
  process.env.SESSION_SECRET ??= 's'.repeat(32);
  process.env.CRON_SECRET ??= 'c'.repeat(16);
  process.env.STORAGE_DRIVER ??= 'local';
});

afterAll(async () => {
  await client.end();
});

class Rollback extends Error {}

async function inRollback(body: (tx: Transaction) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error;
    }
  }
}

const IIN = '910101300123';

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `prof-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `prof-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `prof-b-${suffix}` })
    .returning();

  const [residentUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77071${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const [strangerUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77072${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  // Житель дома A виден админу A только через проживание.
  await tx
    .insert(schema.residencies)
    .values({ orgId, userId: residentUser?.id ?? '', houseId: houseA?.id ?? '' });
  await tx
    .insert(schema.residencies)
    .values({ orgId, userId: strangerUser?.id ?? '', houseId: houseB?.id ?? '' });

  // Акторы — настоящие учётные записи: журнал ссылается на них внешним ключом.
  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77073${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+77074${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseA?.id ?? null,
    })
    .returning();

  const superadmin: AccessContext = {
    orgId,
    userId: superadminUser?.id ?? '',
    role: 'superadmin',
    houseId: null,
  };
  const adminA: AccessContext = {
    orgId,
    userId: adminUser?.id ?? '',
    role: 'admin',
    houseId: houseA?.id ?? null,
  };
  const resident: AccessContext = {
    orgId,
    userId: residentUser?.id ?? '',
    role: 'resident',
    houseId: null,
  };

  return {
    orgId,
    superadmin,
    adminA,
    resident,
    residentId: residentUser?.id ?? '',
    strangerId: strangerUser?.id ?? '',
  };
}

describe('профиль жильца', () => {
  it('заводится при первом чтении и сохраняет открытые поля', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100001');

      const created = await readProfile({ context: fixture.resident }, fixture.residentId, tx);
      expect(created.lastName).toBeNull();

      const saved = await saveProfile(
        { context: fixture.resident },
        fixture.residentId,
        { lastName: 'Ахметов', firstName: 'Азамат', university: 'КазНУ', course: 2 },
        tx,
      );

      expect(saved.lastName).toBe('Ахметов');
      expect(saved.course).toBe(2);
    });
  });

  /**
   * Главное свойство: полные ИИН и УДЛ наружу не отдаются.
   * В профиле остаются только последние четыре знака.
   */
  it('ИИН не возвращается в открытом виде', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100002');

      const saved = await saveProfile(
        { context: fixture.resident },
        fixture.residentId,
        { iin: IIN },
        tx,
      );

      expect(saved.iinMasked).toBe('•••• 0123');
      expect(JSON.stringify(saved)).not.toContain(IIN);
      expect(Object.keys(saved)).not.toContain('iinEnc');
    });
  });

  it('в базе ИИН лежит зашифрованным', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100003');
      await saveProfile({ context: fixture.resident }, fixture.residentId, { iin: IIN }, tx);

      const [row] = await tx
        .select()
        .from(schema.residentProfiles)
        .where(eq(schema.residentProfiles.userId, fixture.residentId));

      expect(row?.iinEnc).toBeDefined();
      expect(Buffer.from(row?.iinEnc ?? new Uint8Array()).toString('utf8')).not.toContain(IIN);
      expect(row?.iinLast4).toBe('0123');
    });
  });

  it('некорректный ИИН отвергается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100004');

      await expect(
        saveProfile({ context: fixture.resident }, fixture.residentId, { iin: '123' }, tx),
      ).rejects.toThrow(/ИИН/);
    });
  });

  it('отметка о здоровье проставляет дату подтверждения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100005');

      const saved = await saveProfile(
        { context: fixture.resident },
        fixture.residentId,
        { noEpilepsy: true, noAsthma: true },
        tx,
      );

      expect(saved.healthDeclaredAt).not.toBeNull();
    });
  });
});

describe('раскрытие ИИН и УДЛ', () => {
  it('отдаёт полное значение и пишет событие в журнал без него', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200001');
      await saveProfile({ context: fixture.resident }, fixture.residentId, { iin: IIN }, tx);

      const value = await revealSensitiveField(
        { context: fixture.superadmin, ip: '203.0.113.8' },
        fixture.residentId,
        'iin',
        tx,
      );

      expect(value).toBe(IIN);

      const entries = await listAuditEntries(fixture.superadmin, {}, tx);
      const reveal = entries.find((entry) => entry.action === AUDIT_ACTIONS.sensitiveFieldRevealed);

      expect(reveal).toBeDefined();
      expect(reveal?.entityId).toBe(fixture.residentId);
      // Значение в журнал не попадает: иначе он станет вторым хранилищем.
      expect(JSON.stringify(reveal)).not.toContain(IIN);
      expect(reveal?.after).toEqual({ field: 'iin' });
    });
  });

  it('незаданное значение раскрыть нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200002');

      await expect(
        revealSensitiveField({ context: fixture.superadmin }, fixture.residentId, 'iin', tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('свой ИИН жилец раскрыть может', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200003');
      await saveProfile({ context: fixture.resident }, fixture.residentId, { iin: IIN }, tx);

      await expect(
        revealSensitiveField({ context: fixture.resident }, fixture.residentId, 'iin', tx),
      ).resolves.toBe(IIN);
    });
  });

  it('чужой ИИН жилец раскрыть не может', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200004');

      await expect(
        revealSensitiveField({ context: fixture.resident }, fixture.strangerId, 'iin', tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('видимость профилей через проживание', () => {
  it('админ видит жильца своего дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300001');

      await expect(
        readProfile({ context: fixture.adminA }, fixture.residentId, tx),
      ).resolves.toBeDefined();
    });
  });

  it('жилец чужого дома админу невидим', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300002');

      await expect(
        readProfile({ context: fixture.adminA }, fixture.strangerId, tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('жилец не читает чужой профиль', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300003');

      await expect(
        readProfile({ context: fixture.resident }, fixture.strangerId, tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('жилец не меняет чужой профиль', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300004');

      await expect(
        saveProfile({ context: fixture.resident }, fixture.strangerId, { lastName: 'Чужой' }, tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('журнал изменений профиля', () => {
  it('зашифрованные значения в журнал не попадают', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '400001');

      await saveProfile(
        { context: fixture.superadmin },
        fixture.residentId,
        { iin: IIN, lastName: 'Ахметов' },
        tx,
      );

      const entries = await listAuditEntries(fixture.superadmin, {}, tx);
      const serialized = JSON.stringify(entries);

      expect(serialized).toContain('Ахметов');
      expect(serialized).not.toContain(IIN);
    });
  });

  /*
   * Роли жильца раскрытие в принципе доступно — но только своей записи.
   * Значит, чужая запись даёт 404, а не 403: действие роли положено,
   * объект вне области видимости (P1-1).
   */
  it('чужая запись для жильца неотличима от несуществующей, а не запрещена', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '400002');
      const foreign: AccessContext = { ...fixture.resident, userId: fixture.strangerId };

      await expect(
        revealSensitiveField({ context: foreign }, fixture.residentId, 'iin', tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
