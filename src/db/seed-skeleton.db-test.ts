import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';

import { seedNetwork } from './seed';
import { ACCOUNT_CODES, accounts, contractTemplates, documentTypes, houses } from './schema';

import type { Database, Transaction } from './client';

/**
 * Скелет сети: `pnpm db:seed --skeleton`.
 *
 * Типы документов, шаблон договора и счета сети экранов не имеют (модули 10
 * и 11), и завести их можно только сидом. На живой базе полный сид неприемлем:
 * он вернёт пять демо-домов с жильцами. Поэтому проверяется ровно граница —
 * что скелет заводит эти три сущности и не трогает дома.
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

describe('скелет сети', () => {
  it('заводит типы документов, шаблон и счета сети, не создавая домов', async () => {
    await inRollback(async (tx) => {
      const before = await tx.select({ id: houses.id }).from(houses);

      const result = await seedNetwork({
        executor: tx,
        houses: 0,
        withContent: false,
        passwordFor: () => 'предсказуемый-пароль',
      });

      const after = await tx.select({ id: houses.id }).from(houses);
      expect(after).toHaveLength(before.length);
      expect(result.houseIds).toEqual([]);
      expect(result.residents).toBe(0);

      // Учётная запись только одна: админ без дома невозможен (users_admin_has_house).
      expect(result.accounts.map((account) => account.role)).toEqual(['superadmin']);

      const types = await tx
        .select()
        .from(documentTypes)
        .where(eq(documentTypes.orgId, result.orgId));
      // Именно вхождение, а не равенство: в общей базе живут ещё и типы приёмок.
      expect(types.map((type) => type.code)).toEqual(
        expect.arrayContaining(['dispensary', 'fluorography', 'photo_3x4']),
      );

      const templates = await tx
        .select()
        .from(contractTemplates)
        .where(eq(contractTemplates.orgId, result.orgId));
      expect(templates.filter((template) => template.isActive)).not.toHaveLength(0);

      const network = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.orgId, result.orgId), isNull(accounts.houseId)));
      // Вхождение, а не равенство: приёмки заводят собственные счета сети.
      expect(network.map((account) => account.code)).toEqual(
        expect.arrayContaining(Object.values(ACCOUNT_CODES).toSorted()),
      );
    });
  });

  it('повторный запуск ничего не удваивает', async () => {
    await inRollback(async (tx) => {
      const options = { executor: tx, houses: 0, withContent: false } as const;

      const first = await seedNetwork(options);
      const afterFirst = await tx
        .select()
        .from(documentTypes)
        .where(eq(documentTypes.orgId, first.orgId));

      await seedNetwork(options);

      const types = await tx
        .select()
        .from(documentTypes)
        .where(eq(documentTypes.orgId, first.orgId));
      const network = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.orgId, first.orgId), isNull(accounts.houseId)));

      // Повторный запуск не должен добавить ни строки — сколько было, столько и есть.
      expect(types).toHaveLength(afterFirst.length);
      expect(network.map((account) => account.code)).toEqual(
        expect.arrayContaining(Object.values(ACCOUNT_CODES).toSorted()),
      );
    });
  });
});
