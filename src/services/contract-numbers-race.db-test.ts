import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';

import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';

import { nextNumberForOrg } from './contract-numbers';

import type { Database } from '@/db/client';

/**
 * Гонка за номером договора (T8.1, чинится в T8.7).
 *
 * Два заселения, ушедшие в базу одновременно, читали максимум номера
 * до того, как соседнее успевало записать своё, — и выбирали один и тот же.
 * Уникальный индекс превращал это в отказ на ровном месте: приёмки трёх
 * ширин заводят жильцов параллельно, и заведение аккаунта падало без причины,
 * видимой человеку.
 *
 * Проверка идёт двумя настоящими соединениями: в одной транзакции такую гонку
 * не воспроизвести, а подделка на уровне моков доказывала бы только моки.
 */
const url = testDatabaseUrl();
const first = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const second = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const dbFirst = drizzle(first, { schema }) as unknown as Database;
const dbSecond = drizzle(second, { schema }) as unknown as Database;

const SLUG = `race-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;

afterAll(async () => {
  await first.end();
  await second.end();
});

describe('одновременные заселения', () => {
  it('получают разные номера договора', async () => {
    const [org] = await dbFirst
      .insert(schema.organizations)
      .values({ name: 'Nice Almaty', slug: SLUG })
      .returning();
    const orgId = org?.id ?? '';

    const [house] = await dbFirst
      .insert(schema.houses)
      .values({ orgId, name: 'Дом гонки', slug: SLUG })
      .returning();

    const [user] = await dbFirst
      .insert(schema.users)
      .values({ orgId, phone: `+7715${SLUG.slice(-7)}`, passwordHash: 'x', role: 'resident' })
      .returning();

    async function allocate(db: Database): Promise<string> {
      return db.transaction(async (tx) => {
        const number = await nextNumberForOrg(orgId, tx);

        /*
         * Пауза между выбором номера и записью: без неё две транзакции успевают
         * разойтись по времени сами, и гонки, из-за которой падали приёмки,
         * в тесте просто не случается.
         */
        await tx.execute(sql`select pg_sleep(0.15)`);

        await tx.insert(schema.residencies).values({
          orgId,
          userId: user?.id ?? '',
          houseId: house?.id ?? '',
          status: 'created',
          contractNumber: number,
        });

        return number;
      });
    }

    try {
      const [left, right] = await Promise.all([allocate(dbFirst), allocate(dbSecond)]);

      expect(left).not.toBe(right);
    } finally {
      await dbFirst.delete(schema.residencies).where(eq(schema.residencies.orgId, orgId));
      await dbFirst.delete(schema.users).where(eq(schema.users.orgId, orgId));
      await dbFirst.delete(schema.houses).where(eq(schema.houses.orgId, orgId));
      await dbFirst.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    }
  });
});
