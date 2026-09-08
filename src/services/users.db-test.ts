import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { listAuditEntries } from '@/db/repositories/audit-log';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import { hashPassword } from '@/lib/password';
import { minusMilliseconds, now, plusMilliseconds } from '@/lib/time';

import { AUDIT_ACTIONS } from './audit';
import { signIn } from './auth';
import {
  allowPasswordReset,
  changeAccountPhone,
  createAccount,
  openResidencyForAccount,
  PASSWORD_RESET_TTL_MS,
} from './users';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';

const url = testDatabaseUrl();
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

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

const PASSWORD = 'pravilny-parol-1';

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `usr-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `usr-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `usr-b-${suffix}` })
    .returning();

  const hash = await hashPassword(PASSWORD);

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77051${suffix}`, passwordHash: hash, role: 'superadmin' })
    .returning();
  const [adminAUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+77052${suffix}`,
      passwordHash: hash,
      role: 'admin',
      houseId: houseA?.id ?? null,
    })
    .returning();
  const [adminBUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+77053${suffix}`,
      passwordHash: hash,
      role: 'admin',
      houseId: houseB?.id ?? null,
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
    userId: adminAUser?.id ?? '',
    role: 'admin',
    houseId: houseA?.id ?? null,
  };

  return {
    orgId,
    superadmin,
    adminA,
    adminBId: adminBUser?.id ?? '',
    adminAPhone: `+77052${suffix}`,
    houseA: houseA?.id ?? '',
  };
}

describe('создание аккаунта жильца (§1.2 п.1)', () => {
  it('заводит проживание в выбранном доме: без него заселять некого', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100010');

      const created = await createAccount(
        { context: fixture.superadmin },
        { phone: `+77054100010`, role: 'resident', houseId: fixture.houseA },
        tx,
      );

      const residencies = await tx
        .select()
        .from(schema.residencies)
        .where(eq(schema.residencies.userId, created.user.id));

      expect(residencies).toHaveLength(1);
      expect(residencies[0]?.houseId).toBe(fixture.houseA);
      expect(residencies[0]?.status).toBe('created');
      // Дом жильца живёт в проживании, а не в учётной записи (D11).
      expect(created.user.houseId).toBeNull();
    });
  });

  it('жилец без дома не создаётся: заселять его было бы некуда', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100011');

      await expect(
        createAccount(
          { context: fixture.superadmin },
          { phone: `+77054100011`, role: 'resident' },
          tx,
        ),
      ).rejects.toThrow();
    });
  });

  it('аккаунт админа заводит проживание в его доме: админ тоже жилец (D11, P9-3)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100012');

      const created = await createAccount(
        { context: fixture.superadmin },
        { phone: `+77054100012`, role: 'admin', houseId: fixture.houseA },
        tx,
      );

      const residencies = await tx
        .select()
        .from(schema.residencies)
        .where(eq(schema.residencies.userId, created.user.id));

      expect(residencies).toHaveLength(1);
      expect(residencies[0]?.houseId).toBe(fixture.houseA);
      expect(residencies[0]?.status).toBe('created');
      // Дом админа остаётся и в учётной записи: им он управляет.
      expect(created.user.houseId).toBe(fixture.houseA);
    });
  });

  it('аккаунт суперадмина проживания не заводит: дома у него нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100013');

      const created = await createAccount(
        { context: fixture.superadmin },
        { phone: `+77054100013`, role: 'superadmin' },
        tx,
      );

      const residencies = await tx
        .select()
        .from(schema.residencies)
        .where(eq(schema.residencies.userId, created.user.id));

      expect(residencies).toHaveLength(0);
    });
  });
});

describe('проживание для учётной записи, заведённой до P9-3', () => {
  it('админу без проживания заводится проживание в его доме и попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100020');

      const residency = await openResidencyForAccount(
        { context: fixture.superadmin },
        fixture.adminBId,
        tx,
      );

      expect(residency.userId).toBe(fixture.adminBId);
      expect(residency.status).toBe('created');
      expect(residency.contractNumber).not.toBeNull();

      const entries = await listAuditEntries(fixture.superadmin, { entityId: residency.id }, tx);
      expect(entries.map((entry) => entry.action)).toContain(AUDIT_ACTIONS.residencyCreated);
    });
  });

  it('повторный вызов ничего не заводит: проживание одно', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100021');

      const first = await openResidencyForAccount(
        { context: fixture.superadmin },
        fixture.adminBId,
        tx,
      );
      const second = await openResidencyForAccount(
        { context: fixture.superadmin },
        fixture.adminBId,
        tx,
      );

      expect(second.id).toBe(first.id);

      const residencies = await tx
        .select()
        .from(schema.residencies)
        .where(eq(schema.residencies.userId, fixture.adminBId));

      expect(residencies).toHaveLength(1);
    });
  });

  it('суперадмину проживание не заводится', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100022');

      await expect(
        openResidencyForAccount({ context: fixture.superadmin }, fixture.superadmin.userId, tx),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('админ проживания не заводит даже себе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100023');

      await expect(
        openResidencyForAccount({ context: fixture.adminA }, fixture.adminA.userId, tx),
      ).rejects.toThrow(ForbiddenError);
    });
  });
});

describe('разрешение сброса пароля', () => {
  it('суперадмин выдаёт разрешение на сутки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100001');
      const before = now();

      const updated = await allowPasswordReset(
        { context: fixture.superadmin, ip: '203.0.113.4' },
        fixture.adminA.userId,
        tx,
      );

      const until = updated.passwordResetAllowedUntil?.getTime() ?? 0;

      expect(until).toBeGreaterThan(before.getTime() + PASSWORD_RESET_TTL_MS - 60_000);
      expect(until).toBeLessThan(before.getTime() + PASSWORD_RESET_TTL_MS + 60_000);
    });
  });

  it('каждое разрешение попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100002');

      await allowPasswordReset(
        { context: fixture.superadmin, ip: '203.0.113.5' },
        fixture.adminA.userId,
        tx,
      );

      const entries = await listAuditEntries(fixture.superadmin, {}, tx);
      const entry = entries.find((item) => item.action === AUDIT_ACTIONS.passwordResetAllowed);

      expect(entry).toBeDefined();
      expect(entry?.entityId).toBe(fixture.adminA.userId);
      expect(entry?.ip).toBe('203.0.113.5');
    });
  });

  it('после выдачи вход проходит с любым паролем ровно один раз', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100003');

      await allowPasswordReset({ context: fixture.superadmin }, fixture.adminA.userId, tx);

      const first = await signIn({ phone: fixture.adminAPhone, password: 'sovsem-ne-parol' }, tx);
      expect(first.usedResetPermission).toBe(true);
      expect(first.mustChangePassword).toBe(true);

      await expect(
        signIn({ phone: fixture.adminAPhone, password: 'drugoy-ne-parol' }, tx),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  it('просроченное разрешение не действует', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100004');

      await tx
        .update(schema.users)
        .set({ passwordResetAllowedUntil: minusMilliseconds(now(), 1000) })
        .where(eq(schema.users.id, fixture.adminA.userId));

      await expect(
        signIn({ phone: fixture.adminAPhone, password: 'lyuboy' }, tx),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  it('выдача поверх действующего разрешения продлевает срок, а не копит их', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100005');

      await tx
        .update(schema.users)
        .set({ passwordResetAllowedUntil: plusMilliseconds(now(), 1000) })
        .where(eq(schema.users.id, fixture.adminA.userId));

      const updated = await allowPasswordReset(
        { context: fixture.superadmin },
        fixture.adminA.userId,
        tx,
      );

      expect(updated.passwordResetAllowedUntil?.getTime()).toBeGreaterThan(
        now().getTime() + PASSWORD_RESET_TTL_MS - 60_000,
      );
    });
  });
});

describe('кто вправе выдавать разрешение', () => {
  it('админ не видит учётную запись чужого дома — она неотличима от несуществующей', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200001');

      await expect(
        allowPasswordReset({ context: fixture.adminA }, fixture.adminBId, tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('жилец не может выдать разрешение даже себе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200002');

      const [residentUser] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77059200002',
          passwordHash: await hashPassword(PASSWORD),
          role: 'resident',
        })
        .returning();

      const resident: AccessContext = {
        orgId: fixture.orgId,
        userId: residentUser?.id ?? '',
        role: 'resident',
        houseId: null,
      };

      await expect(
        allowPasswordReset({ context: resident }, resident.userId, tx),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('чужая сеть недоступна и суперадмину', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200003');

      const [otherOrg] = await tx
        .insert(schema.organizations)
        .values({ name: 'Другая сеть', slug: 'usr-other-200003' })
        .returning();
      const [stranger] = await tx
        .insert(schema.users)
        .values({
          orgId: otherOrg?.id ?? '',
          phone: '+77059200003',
          passwordHash: await hashPassword(PASSWORD),
          role: 'resident',
        })
        .returning();

      await expect(
        allowPasswordReset({ context: fixture.superadmin }, stranger?.id ?? '', tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('смена номера телефона (T9.7)', () => {
  it('свой номер меняется с действующим паролем и попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100030');

      const updated = await changeAccountPhone(
        { context: fixture.adminA },
        fixture.adminA.userId,
        { phone: '+7 (705) 100-00-30', currentPassword: PASSWORD },
        tx,
      );

      expect(updated.phone).toBe('+77051000030');

      const entries = await listAuditEntries(
        fixture.superadmin,
        { entityId: fixture.adminA.userId },
        tx,
      );
      const change = entries.find((entry) => entry.action === AUDIT_ACTIONS.userPhoneChanged);
      expect(change?.before).toMatchObject({ phone: fixture.adminAPhone });
      expect(change?.after).toMatchObject({ phone: '+77051000030' });
    });
  });

  it('свой номер без пароля или с неверным не меняется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100031');

      await expect(
        changeAccountPhone(
          { context: fixture.adminA },
          fixture.adminA.userId,
          { phone: '+77051000031' },
          tx,
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        changeAccountPhone(
          { context: fixture.adminA },
          fixture.adminA.userId,
          { phone: '+77051000031', currentPassword: 'не тот пароль' },
          tx,
        ),
      ).rejects.toThrow(ValidationError);

      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, fixture.adminA.userId));
      expect(user?.phone).toBe(fixture.adminAPhone);
    });
  });

  it('суперадмин меняет чужой номер без пароля', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100032');

      const updated = await changeAccountPhone(
        { context: fixture.superadmin },
        fixture.adminBId,
        { phone: '+77051000032' },
        tx,
      );

      expect(updated.phone).toBe('+77051000032');
    });
  });

  it('занятый номер не отдаётся', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100033');

      await expect(
        changeAccountPhone(
          { context: fixture.superadmin },
          fixture.adminBId,
          { phone: fixture.adminAPhone },
          tx,
        ),
      ).rejects.toThrow(ConflictError);
    });
  });

  it('админ меняет номер жильца своего дома — по дому проживания', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100034');

      const created = await createAccount(
        { context: fixture.superadmin },
        { phone: '+77054100034', role: 'resident', houseId: fixture.houseA },
        tx,
      );

      const updated = await changeAccountPhone(
        { context: fixture.adminA },
        created.user.id,
        { phone: '+77054100035' },
        tx,
      );

      expect(updated.phone).toBe('+77054100035');
    });
  });

  it('админ чужого дома не видит учётную запись — она неотличима от несуществующей', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100036');

      await expect(
        changeAccountPhone(
          { context: fixture.adminA },
          fixture.adminBId,
          { phone: '+77051000036' },
          tx,
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  it('жилец чужой номер не меняет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100037');

      const created = await createAccount(
        { context: fixture.superadmin },
        { phone: '+77054100037', role: 'resident', houseId: fixture.houseA },
        tx,
      );
      const resident: AccessContext = {
        orgId: fixture.orgId,
        userId: created.user.id,
        role: 'resident',
        houseId: null,
      };

      await expect(
        changeAccountPhone(
          { context: resident },
          fixture.adminA.userId,
          { phone: '+77051000037' },
          tx,
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
