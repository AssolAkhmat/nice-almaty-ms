import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, ValidationError } from '@/lib/errors';

import {
  previewContractTemplate,
  readContractTemplate,
  saveContractTemplate,
} from './contract-templates';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Редактор шаблона договора (T8.4, модуль 11).
 *
 * Шаблон заводил только сид, и править его можно было лишь запросом в базу.
 * Проверяется то, что нельзя выпустить наружу: неизвестный токен не должен
 * попасть в шаблон, иначе договор перестанет собираться у первого же жильца.
 */
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

interface Fixture {
  superadmin: UserActor;
  admin: UserActor;
  orgId: string;
}

async function seed(tx: Transaction, suffix: string): Promise<Fixture> {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `ct-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `ct-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [chief] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7713${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [manager] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7714${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  await tx.insert(schema.contractTemplates).values({
    orgId,
    name: 'Базовый договор найма',
    version: 1,
    bodyHtml: '<p>Договор № {{residency.contract_number}}</p>',
    tokens: [],
    isActive: true,
  });

  const actor = (userId: string, role: AccessContext['role'], house: string | null): UserActor => ({
    context: { orgId, userId, role, houseId: house },
    requestId: `ct-${suffix}`,
  });

  return {
    orgId,
    superadmin: actor(chief?.id ?? '', 'superadmin', null),
    admin: actor(manager?.id ?? '', 'admin', houseId),
  };
}

describe('шаблон договора', () => {
  it('суперадмин читает активный шаблон', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4001');

      const template = await readContractTemplate(fixture.superadmin, tx);

      expect(template.name).toBe('Базовый договор найма');
      expect(template.bodyHtml).toContain('contract_number');
    });
  });

  it('правка сохраняется и попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4002');

      const saved = await saveContractTemplate(
        fixture.superadmin,
        {
          name: 'Договор найма 2026',
          bodyHtml: '<p>{{resident.full_name}} — {{house.name}}</p>',
        },
        tx,
      );

      expect(saved.name).toBe('Договор найма 2026');

      const stored = await readContractTemplate(fixture.superadmin, tx);
      expect(stored.bodyHtml).toContain('resident.full_name');

      const audit = await tx.select().from(schema.auditLog);
      expect(audit.some((row) => row.action === 'contract_template.saved')).toBe(true);
    });
  });

  it('неизвестный токен не сохраняется и назван в ошибке', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4003');

      await expect(
        saveContractTemplate(
          fixture.superadmin,
          { name: 'Договор', bodyHtml: '<p>{{resident.middle_name}}</p>' },
          tx,
        ),
      ).rejects.toThrow(ValidationError);

      const stored = await readContractTemplate(fixture.superadmin, tx);
      expect(stored.bodyHtml).not.toContain('middle_name');
    });
  });

  it('пустой шаблон не сохраняется: без текста договор не собрать', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4004');

      await expect(
        saveContractTemplate(fixture.superadmin, { name: 'Договор', bodyHtml: '   ' }, tx),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('предпросмотр идёт на выдуманных данных и не оставляет скобок', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4005');

      const html = await previewContractTemplate(
        fixture.superadmin,
        '<p>{{resident.full_name}}, ИИН {{resident.iin}}</p>',
      );

      expect(html).not.toContain('{{');
      expect(html).toContain('Иванов Иван Иванович');
    });
  });

  it('админ дома шаблон не читает и не правит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4006');

      await expect(readContractTemplate(fixture.admin, tx)).rejects.toThrow(ForbiddenError);
      await expect(
        saveContractTemplate(fixture.admin, { name: 'Своё', bodyHtml: '<p>{{today}}</p>' }, tx),
      ).rejects.toThrow(ForbiddenError);
      await expect(previewContractTemplate(fixture.admin, '<p>{{today}}</p>')).rejects.toThrow(
        ForbiddenError,
      );
    });
  });
});
