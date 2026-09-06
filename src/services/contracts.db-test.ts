import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { createLocalStorage } from '@/adapters/storage/local';
import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { buildContract, markKeysIssued, signContract } from './contracts';
import { saveProfile } from './resident-profiles';

import type { PdfRenderer } from '@/adapters/pdf';
import type { StorageProvider } from '@/adapters/storage';
import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Договор: сборка из шаблона, подпись и отметка о ключах.
 *
 * Настоящий chromium здесь не запускается — печать подменена, и проверяется
 * то, что от неё зависит: какой HTML уходит в печать, куда ложится PDF
 * и что записано в проживании. Сам драйвер печати проверен отдельно
 * в `src/adapters/pdf/chromium.test.ts`.
 */
const url = testDatabaseUrl();
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

const roots: string[] = [];

afterAll(async () => {
  await client.end();
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function freshStorage(): StorageProvider {
  const root = mkdtempSync(join(tmpdir(), 'nice-contract-'));
  roots.push(root);

  return createLocalStorage(root);
}

/** Подделка печати: запоминает HTML и отдаёт узнаваемые байты PDF. */
function fakePdf() {
  const printed: string[] = [];

  const renderer: PdfRenderer = {
    driver: 'chromium',
    checkHealth: () => Promise.resolve({ status: 'ok', driver: 'chromium' }),
    render: (html) => {
      printed.push(html);

      return Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    },
  };

  return { printed, renderer };
}

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

const TEMPLATE = [
  '<h1>Договор найма</h1>',
  '<p>Наниматель: {{resident.full_name}}, ИИН {{resident.iin}}</p>',
  '<p>{{house.name}}, {{bed.room}}, {{bed.label}}, {{bed.price}}</p>',
  '<p>Срок: {{residency.contract_start}} — {{residency.contract_end}}</p>',
  '<p>Дата: {{today}}</p>',
].join('');

const TODAY = parseBusinessDate('2026-09-01');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `ctr-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом 1', slug: `ctr-a-${suffix}`, address: 'Алматы, Абая 1' })
    .returning();

  await tx.insert(schema.contractTemplates).values({
    orgId,
    name: 'Основной',
    version: 1,
    bodyHtml: TEMPLATE,
    isActive: true,
  });

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7706${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [admin] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7705${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: house?.id ?? '',
    })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: user?.id ?? '',
      houseId: house?.id ?? '',
      contractStart: '2026-09-01',
      contractEnd: '2027-07-01',
    })
    .returning();

  const [area] = await tx
    .insert(schema.areas)
    .values({ houseId: house?.id ?? '', name: 'Комната 3', type: 'living' })
    .returning();

  const [bed] = await tx
    .insert(schema.beds)
    .values({
      houseId: house?.id ?? '',
      areaId: area?.id ?? '',
      number: 2,
      tier: 'upper',
      label: 'Место 2, верх',
      defaultPrice: 120_000,
    })
    .returning();

  await tx.insert(schema.bedAssignments).values({
    residencyId: residency?.id ?? '',
    bedId: bed?.id ?? '',
    price: 120_000,
    period: '[2026-09-01,)',
  });

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  const adminActor = actor(context('admin', admin?.id ?? '', house?.id ?? null));

  await saveProfile(
    adminActor,
    user?.id ?? '',
    { lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович', iin: '990101300123' },
    tx,
  );

  return {
    orgId,
    residencyId: residency?.id ?? '',
    userId: user?.id ?? '',
    resident: actor(context('resident', user?.id ?? '', null)),
    admin: adminActor,
  };
}

/** Подпись, уже принятая двухшаговой загрузкой: PNG в хранилище и запись в files. */
async function signatureFile(
  tx: Transaction,
  storage: StorageProvider,
  fixture: { orgId: string; residencyId: string; userId: string },
  mime = 'image/png',
): Promise<string> {
  const path = `signatures/${fixture.residencyId}.png`;
  await storage.put(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  const [file] = await tx
    .insert(schema.files)
    .values({
      orgId: fixture.orgId,
      residencyId: fixture.residencyId,
      provider: 'local',
      path,
      mime,
      sizeBytes: 4,
      originalName: 'signature.png',
      uploadedBy: fixture.userId,
      status: 'ready',
    })
    .returning();

  return file?.id ?? '';
}

describe('сборка договора', () => {
  it('подставляет значения проживания и кладёт PDF в хранилище', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6001');
      const storage = freshStorage();
      const pdf = fakePdf();

      const result = await buildContract(fixture.admin, fixture.residencyId, {
        executor: tx,
        storage,
        pdf: pdf.renderer,
        today: TODAY,
      });

      expect(result.file.mime).toBe('application/pdf');
      expect(result.file.status).toBe('ready');
      expect(result.residency.contractFileId).toBe(result.file.id);

      const html = pdf.printed[0] ?? '';
      expect(html).toContain('Иванов Иван Иванович');
      expect(html).toContain('990101300123');
      expect(html).toContain('Комната 3');
      expect(html).toContain('Место 2, верх');
      expect(html).toContain('01.09.2026');
      expect(html).toContain('01.07.2027');

      expect(await storage.head(result.file.path)).not.toBeNull();
    });
  });

  it('без активного шаблона договор не собирается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6002');
      await tx.update(schema.contractTemplates).set({ isActive: false });

      await expect(
        buildContract(fixture.admin, fixture.residencyId, {
          executor: tx,
          storage: freshStorage(),
          pdf: fakePdf().renderer,
          today: TODAY,
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  it('шаблон с неизвестным токеном отвергается до печати', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6003');
      await tx.update(schema.contractTemplates).set({ bodyHtml: '<p>{{resident.salary}}</p>' });

      const pdf = fakePdf();

      await expect(
        buildContract(fixture.admin, fixture.residencyId, {
          executor: tx,
          storage: freshStorage(),
          pdf: pdf.renderer,
          today: TODAY,
        }),
      ).rejects.toThrow(ValidationError);

      expect(pdf.printed).toHaveLength(0);
    });
  });

  it('чужое проживание неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const first = await seed(tx, '6004');
      const second = await seed(tx, '6005');

      await expect(
        buildContract(first.admin, second.residencyId, {
          executor: tx,
          storage: freshStorage(),
          pdf: fakePdf().renderer,
          today: TODAY,
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  it('сборка и раскрытие ИИН попадают в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6006');

      await buildContract(fixture.admin, fixture.residencyId, {
        executor: tx,
        storage: freshStorage(),
        pdf: fakePdf().renderer,
        today: TODAY,
      });

      const actions = (await tx.select().from(schema.auditLog)).map((entry) => entry.action);

      expect(actions).toContain('contract.generated');
      // Договор не должен быть лазейкой в обход журнала раскрытий.
      expect(actions).toContain('resident.sensitive_field_revealed');
    });
  });
});

describe('подпись договора', () => {
  it('вкладывает подпись в документ и отмечает дату', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6010');
      const storage = freshStorage();
      const pdf = fakePdf();

      const signatureId = await signatureFile(tx, storage, fixture);

      const result = await signContract(fixture.resident, fixture.residencyId, signatureId, {
        executor: tx,
        storage,
        pdf: pdf.renderer,
        today: TODAY,
      });

      expect(result.residency.contractSignedAt).not.toBeNull();
      expect(result.residency.signatureFileId).toBe(signatureId);
      expect(result.residency.contractFileId).toBe(result.file.id);

      const html = pdf.printed[0] ?? '';
      expect(html).toContain('data:image/png;base64,');
    });
  });

  it('подпись не PNG не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6011');
      const storage = freshStorage();
      const signatureId = await signatureFile(tx, storage, fixture, 'application/pdf');

      await expect(
        signContract(fixture.resident, fixture.residencyId, signatureId, {
          executor: tx,
          storage,
          pdf: fakePdf().renderer,
          today: TODAY,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('повторная подпись невозможна', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6012');
      const storage = freshStorage();
      const signatureId = await signatureFile(tx, storage, fixture);

      await signContract(fixture.resident, fixture.residencyId, signatureId, {
        executor: tx,
        storage,
        pdf: fakePdf().renderer,
        today: TODAY,
      });

      await expect(
        signContract(fixture.resident, fixture.residencyId, signatureId, {
          executor: tx,
          storage,
          pdf: fakePdf().renderer,
          today: TODAY,
        }),
      ).rejects.toThrow(ConflictError);
    });
  });

  it('подписанный договор не пересобирается: подпись стояла бы под другим текстом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6013');
      const storage = freshStorage();
      const signatureId = await signatureFile(tx, storage, fixture);

      await signContract(fixture.resident, fixture.residencyId, signatureId, {
        executor: tx,
        storage,
        pdf: fakePdf().renderer,
        today: TODAY,
      });

      await expect(
        buildContract(fixture.admin, fixture.residencyId, {
          executor: tx,
          storage,
          pdf: fakePdf().renderer,
          today: TODAY,
        }),
      ).rejects.toThrow(ConflictError);
    });
  });

  it('подпись попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6014');
      const storage = freshStorage();
      const signatureId = await signatureFile(tx, storage, fixture);

      await signContract(fixture.resident, fixture.residencyId, signatureId, {
        executor: tx,
        storage,
        pdf: fakePdf().renderer,
        today: TODAY,
      });

      const actions = (await tx.select().from(schema.auditLog)).map((entry) => entry.action);
      expect(actions).toContain('contract.signed');
    });
  });
});

describe('ключи выданы', () => {
  it('подпись договора ключи не выдаёт: это разные отметки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6020');
      const storage = freshStorage();
      const signatureId = await signatureFile(tx, storage, fixture);

      const result = await signContract(fixture.resident, fixture.residencyId, signatureId, {
        executor: tx,
        storage,
        pdf: fakePdf().renderer,
        today: TODAY,
      });

      expect(result.residency.keysIssued).toBe(false);
    });
  });

  it('админ отмечает выдачу ключей, и это идёт в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6021');

      const residency = await markKeysIssued(fixture.admin, fixture.residencyId, { executor: tx });

      expect(residency.keysIssued).toBe(true);
      expect(residency.keysIssuedAt).not.toBeNull();

      const actions = (await tx.select().from(schema.auditLog)).map((entry) => entry.action);
      expect(actions).toContain('residency.keys_issued');
    });
  });

  it('повторная отметка ничего не меняет и не дублирует запись', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6022');

      const first = await markKeysIssued(fixture.admin, fixture.residencyId, { executor: tx });
      const second = await markKeysIssued(fixture.admin, fixture.residencyId, { executor: tx });

      expect(second.keysIssuedAt).toEqual(first.keysIssuedAt);

      const entries = (await tx.select().from(schema.auditLog)).filter(
        (entry) => entry.action === 'residency.keys_issued',
      );
      expect(entries).toHaveLength(1);
    });
  });

  it('жилец не собирает договор сам: это делает админ', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6024');

      await expect(
        buildContract(fixture.resident, fixture.residencyId, {
          executor: tx,
          storage: freshStorage(),
          pdf: fakePdf().renderer,
          today: TODAY,
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  it('админ не подписывает договор за жильца: подпись личная', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6025');
      const storage = freshStorage();
      const signatureId = await signatureFile(tx, storage, fixture);

      await expect(
        signContract(fixture.admin, fixture.residencyId, signatureId, {
          executor: tx,
          storage,
          pdf: fakePdf().renderer,
          today: TODAY,
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  it('жилец сам себе ключи не выдаёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6023');

      await expect(
        markKeysIssued(fixture.resident, fixture.residencyId, { executor: tx }),
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
