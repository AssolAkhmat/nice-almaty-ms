import { and, eq, inArray, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';

import { seedNetwork } from './seed';
import { BEDS_PER_ROOM, FURNISHED_HOUSES, OCCUPANCY, ROOMS_PER_HOUSE } from './seed-content';

import type { Database, Executor, Transaction } from './client';

/**
 * Сид сети (docs/07-ROADMAP.md, «Сид-данные»).
 *
 * Проверяется состав и то, ради чего сид вообще перезапускают: повторный
 * запуск не удваивает ни общежитие, ни его жильцов.
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

/**
 * Сид идёт поверх существующей сети: удалить её нельзя — на неё ссылается
 * всё, вплоть до журнала аудита, — да и незачем. Ровно так его и запускают
 * в жизни: повторно, на живой базе. Проверки поэтому смотрят на сидовые
 * дома и сидовых жильцов, а не на общие счётчики таблиц: в общей базе
 * живут ещё и данные приёмок.
 */
async function runSeed(tx: Transaction) {
  return seedNetwork({
    executor: tx as unknown as Executor,
    passwordFor: (phone) => `пароль-${phone}`,
  });
}

/** Жильцы сида узнаются по номеру: приёмки пользуются другими диапазонами. */
const SEED_RESIDENT_PREFIX = '+7702';

describe('состав сида', () => {
  it('первые пять домов обставлены местами', async () => {
    await inRollback(async (tx) => {
      const result = await runSeed(tx);

      const furnished = result.houseIds.slice(0, FURNISHED_HOUSES);

      const withBeds = await tx
        .select({ houseId: schema.beds.houseId })
        .from(schema.beds)
        .where(inArray(schema.beds.houseId, furnished));

      const houses = new Set(withBeds.map((row) => row.houseId));

      for (const houseId of furnished) {
        expect(houses.has(houseId), houseId).toBe(true);
      }
    });
  });

  it('в обставленном доме есть комнаты, зоны с чек-листами и жильцы', async () => {
    await inRollback(async (tx) => {
      const result = await runSeed(tx);
      const houseId = result.houseIds[0] ?? '';

      const rooms = await tx
        .select()
        .from(schema.areas)
        .where(and(eq(schema.areas.houseId, houseId), eq(schema.areas.type, 'living')));
      const zones = await tx
        .select()
        .from(schema.areas)
        .where(and(eq(schema.areas.houseId, houseId), eq(schema.areas.type, 'common')));
      const residents = await tx
        .select()
        .from(schema.residencies)
        .where(eq(schema.residencies.houseId, houseId));

      expect(rooms.length).toBeGreaterThan(0);
      expect(zones.length).toBeGreaterThan(0);
      expect(residents.length).toBeGreaterThan(0);

      const checklists = await tx
        .select()
        .from(schema.areaChecklists)
        .where(
          inArray(
            schema.areaChecklists.areaId,
            zones.map((zone) => zone.id),
          ),
        );

      expect(checklists.length).toBe(zones.length);
    });
  });

  it('места не заняты целиком: свободные нужны боту и заселению', async () => {
    await inRollback(async (tx) => {
      await runSeed(tx);

      /*
       * Считаются свои: в доме 1 живут ещё и жильцы приёмок, оставшиеся
       * от прошлых прогонов. Сид узнаётся по диапазону номеров.
       */
      const seededBeds = ROOMS_PER_HOUSE * BEDS_PER_ROOM;
      const residents = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(like(schema.users.phone, '+770201%'));

      expect(residents.length).toBe(Math.floor(seededBeds * OCCUPANCY));
      expect(residents.length).toBeLessThan(seededBeds);
      expect(residents.length).toBeGreaterThan(seededBeds / 2);
    });
  });

  it('ряды ротаций стоят на вторник, четверг и воскресенье', async () => {
    await inRollback(async (tx) => {
      const result = await runSeed(tx);
      const houseId = result.houseIds[0] ?? '';

      const rows = await tx
        .select()
        .from(schema.rotationRows)
        .where(eq(schema.rotationRows.houseId, houseId));

      expect(rows.map((row) => row.weekday).sort((left, right) => left - right)).toEqual([2, 4, 7]);
    });
  });

  it('у сидовых жильцов истории нет: ни счетов, ни событий рейтинга', async () => {
    await inRollback(async (tx) => {
      await runSeed(tx);

      const residents = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(like(schema.users.phone, `${SEED_RESIDENT_PREFIX}%`));

      const ids = residents.map((row) => row.id);
      expect(ids.length).toBeGreaterThan(0);

      const invoices = await tx
        .select()
        .from(schema.invoices)
        .where(inArray(schema.invoices.userId, ids));
      const events = await tx
        .select()
        .from(schema.ratingEvents)
        .where(inArray(schema.ratingEvents.userId, ids));

      expect(invoices).toEqual([]);
      expect(events).toEqual([]);
    });
  });
});

describe('повторный запуск', () => {
  it('ничего не удваивает', async () => {
    await inRollback(async (tx) => {
      const first = await runSeed(tx);
      const houseId = first.houseIds[0] ?? '';

      const countRows = async () => ({
        houses: (await tx.select().from(schema.houses)).length,
        beds: (await tx.select().from(schema.beds).where(eq(schema.beds.houseId, houseId))).length,
        residents: (
          await tx.select().from(schema.residencies).where(eq(schema.residencies.houseId, houseId))
        ).length,
        rows: (
          await tx
            .select()
            .from(schema.rotationRows)
            .where(eq(schema.rotationRows.houseId, houseId))
        ).length,
      });

      const before = await countRows();

      const second = await seedNetwork({
        executor: tx as unknown as Executor,
        passwordFor: (phone) => `пароль-${phone}`,
      });

      expect(second.residents).toBe(0);
      expect(await countRows()).toEqual(before);
    });
  });
});
