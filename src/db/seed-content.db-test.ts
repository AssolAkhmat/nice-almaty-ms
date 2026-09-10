import { and, eq, inArray, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { startOfDayUtc, toAlmatyParts, type BusinessDate } from '@/lib/time';

import { houseSlug, seedNetwork } from './seed';
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

/**
 * Ряды дома вместе с версиями и занятиями. Сид идёт поверх живой базы
 * и заведённые ряды не трогает, а на машине разработчика они могут быть
 * прежней формы: проверяется сборка с чистого листа, внутри отката.
 */
async function removeRows(tx: Transaction, houseId: string): Promise<void> {
  const occurrenceIds = (
    await tx
      .select({ id: schema.rotationOccurrences.id })
      .from(schema.rotationOccurrences)
      .where(eq(schema.rotationOccurrences.houseId, houseId))
  ).map((row) => row.id);

  if (occurrenceIds.length > 0) {
    const assignmentIds = (
      await tx
        .select({ id: schema.rotationAssignments.id })
        .from(schema.rotationAssignments)
        .where(inArray(schema.rotationAssignments.occurrenceId, occurrenceIds))
    ).map((row) => row.id);

    if (assignmentIds.length > 0) {
      await tx
        .delete(schema.rotationDebts)
        .where(inArray(schema.rotationDebts.sourceAssignmentId, assignmentIds));
      await tx
        .delete(schema.rotationAssignments)
        .where(inArray(schema.rotationAssignments.id, assignmentIds));
    }

    await tx
      .delete(schema.rotationOccurrences)
      .where(inArray(schema.rotationOccurrences.id, occurrenceIds));
  }

  const rowIds = (
    await tx
      .select({ id: schema.rotationRows.id })
      .from(schema.rotationRows)
      .where(eq(schema.rotationRows.houseId, houseId))
  ).map((row) => row.id);

  if (rowIds.length === 0) {
    return;
  }

  const rosterIds = (
    await tx
      .select({ id: schema.rotationRowRosters.id })
      .from(schema.rotationRowRosters)
      .where(inArray(schema.rotationRowRosters.rowId, rowIds))
  ).map((row) => row.id);

  if (rosterIds.length > 0) {
    await tx
      .delete(schema.rotationRowRosterSlots)
      .where(inArray(schema.rotationRowRosterSlots.rosterId, rosterIds));
    await tx
      .delete(schema.rotationRowRosters)
      .where(inArray(schema.rotationRowRosters.id, rosterIds));
  }

  const normIds = (
    await tx
      .select({ id: schema.rotationDayNorms.id })
      .from(schema.rotationDayNorms)
      .where(inArray(schema.rotationDayNorms.rowId, rowIds))
  ).map((row) => row.id);

  if (normIds.length > 0) {
    await tx
      .delete(schema.rotationDayNormZones)
      .where(inArray(schema.rotationDayNormZones.normId, normIds));
    await tx.delete(schema.rotationDayNorms).where(inArray(schema.rotationDayNorms.id, normIds));
  }

  await tx.delete(schema.rotationRows).where(inArray(schema.rotationRows.id, rowIds));
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

  /*
   * День недели в базе — 0 (воскресенье) … 6 (суббота), как в `src/lib/time.ts`.
   * Проверяется не только сам список, но и согласие с датой первой ротации:
   * разойдясь с ней, ряд сдвинул бы всю сетку на день, а экран назвал бы
   * день недели, которого нет.
   */
  it('ряды ротаций стоят на вторник, четверг и воскресенье', async () => {
    await inRollback(async (tx) => {
      const result = await runSeed(tx);
      const houseId = result.houseIds[0] ?? '';

      const rows = await tx
        .select()
        .from(schema.rotationRows)
        .where(eq(schema.rotationRows.houseId, houseId));

      expect(rows.map((row) => row.weekday).sort((left, right) => left - right)).toEqual([0, 2, 4]);

      for (const row of rows) {
        const startWeekday = toAlmatyParts(startOfDayUtc(row.startDate as BusinessDate)).weekday;

        expect(startWeekday).toBe(row.weekday);
      }
    });
  });

  /**
   * Модель фазы 10: ряд — состав мест и норма зон с датой вступления. Ряды
   * делят места дома по дням, каждый жилец убирает раз в неделю (§2.2),
   * число людей на зону — из её чек-листа (кухня на двоих).
   */
  it('составы делят места по дням, нормы берут число людей из чек-листа', async () => {
    await inRollback(async (tx) => {
      const [first] = await tx
        .select({ id: schema.houses.id })
        .from(schema.houses)
        .where(eq(schema.houses.slug, houseSlug(1)));

      if (first !== undefined) {
        await removeRows(tx, first.id);
      }

      const result = await runSeed(tx);
      const houseId = result.houseIds[0] ?? '';

      const rows = await tx
        .select()
        .from(schema.rotationRows)
        .where(eq(schema.rotationRows.houseId, houseId));
      const rowIds = rows.map((row) => row.id);

      const rosters = await tx
        .select()
        .from(schema.rotationRowRosters)
        .where(inArray(schema.rotationRowRosters.rowId, rowIds));
      const slots = await tx
        .select()
        .from(schema.rotationRowRosterSlots)
        .where(
          inArray(
            schema.rotationRowRosterSlots.rosterId,
            rosters.map((roster) => roster.id),
          ),
        );

      const houseBeds = await tx
        .select({ id: schema.beds.id })
        .from(schema.beds)
        .where(eq(schema.beds.houseId, houseId));

      // Каждое место дома — ровно в одном составе.
      expect(rosters).toHaveLength(rows.length);
      expect(slots.map((slot) => slot.bedId).sort()).toEqual(houseBeds.map((bed) => bed.id).sort());

      const norms = await tx
        .select()
        .from(schema.rotationDayNorms)
        .where(inArray(schema.rotationDayNorms.rowId, rowIds));
      const normZones = await tx
        .select()
        .from(schema.rotationDayNormZones)
        .where(
          inArray(
            schema.rotationDayNormZones.normId,
            norms.map((norm) => norm.id),
          ),
        );

      expect(norms).toHaveLength(rows.length);

      const [kitchen] = await tx
        .select({ id: schema.areas.id })
        .from(schema.areas)
        .where(and(eq(schema.areas.houseId, houseId), eq(schema.areas.name, 'Кухня')));
      const kitchenZones = normZones.filter((zone) => zone.areaId === kitchen?.id);

      // Кухня стоит в норме каждого дня и всюду на двоих — как в её чек-листе.
      expect(kitchenZones).toHaveLength(rows.length);
      expect(kitchenZones.every((zone) => zone.people === 2)).toBe(true);
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
