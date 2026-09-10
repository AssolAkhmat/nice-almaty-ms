import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError } from '@/lib/errors';
import { parseBusinessDate, type BusinessDate } from '@/lib/time';

import { assignBedToResidency, releaseBedOfResidency } from './beds';
import { saveRow } from './rotation-rows';
import { generateSchedule, readSchedule, refreshFutureAssignments } from './rotation-schedule';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Материализация расписания (docs/03-BUSINESS-RULES.md §6.2, §6.3, §6.6).
 *
 * Здесь проверяется то, ради чего сетка и считается: занятия и назначения
 * в базе. Числовой пример 6.1 — шесть мест и пять зон — разложен по неделям.
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

/** Понедельник — день ряда; «сегодня» прогона совпадает с датой старта. */
const MONDAY = parseBusinessDate('2026-09-07');
const NEXT_MONDAY = parseBusinessDate('2026-09-14');
const FOURTH_MONDAY = parseBusinessDate('2026-09-28');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `sched-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `sched-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  async function area(name: string, type: 'living' | 'common'): Promise<string> {
    const [row] = await tx.insert(schema.areas).values({ houseId, type, name }).returning();

    return row?.id ?? '';
  }

  const room = await area('Комната 1', 'living');
  const hall = await area('Зал', 'common');
  const kitchen = await area('Кухня', 'common');
  const stairs = await area('Лестница', 'common');
  const toilet1 = await area('Туалет 1', 'common');
  const toilet2 = await area('Туалет 2', 'common');

  async function checklist(areaId: string, peopleNeeded = 1): Promise<string> {
    const [row] = await tx
      .insert(schema.areaChecklists)
      .values({ areaId, type: 'regular', title: 'Уборка', peopleNeeded })
      .returning();

    return row?.id ?? '';
  }

  const zones = [
    { areaId: hall, checklistId: await checklist(hall) },
    { areaId: kitchen, checklistId: await checklist(kitchen) },
    { areaId: stairs, checklistId: await checklist(stairs) },
    { areaId: toilet1, checklistId: await checklist(toilet1) },
    { areaId: toilet2, checklistId: await checklist(toilet2) },
  ];

  const beds: string[] = [];
  for (let number = 1; number <= 6; number += 1) {
    const [bed] = await tx
      .insert(schema.beds)
      .values({ houseId, areaId: room, label: `М${String(number)}`, tier: 'lower', number })
      .returning();
    beds.push(bed?.id ?? '');
  }

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();
  const [residentUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: forHouse });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  /** Селит жильца на место с указанной даты; возвращает его идентификатор. */
  async function moveIn(bedId: string, from: BusinessDate, to?: BusinessDate): Promise<string> {
    const [user] = await tx
      .insert(schema.users)
      .values({
        orgId,
        phone: `+7705${suffix}${String(beds.indexOf(bedId))}${to === undefined ? '0' : '1'}`,
        passwordHash: 'x',
        role: 'resident',
      })
      .returning();
    const userId = user?.id ?? '';

    const [residency] = await tx
      .insert(schema.residencies)
      .values({ orgId, userId, houseId, status: 'active', moveInDate: from })
      .returning();

    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId,
      price: 100_000,
      period: to === undefined ? `[${from},)` : `[${from},${to})`,
    });

    return userId;
  }

  return {
    orgId,
    houseId,
    room,
    zones,
    beds,
    moveIn,
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    resident: actor(context('resident', residentUser?.id ?? '', null)),
  };
}

/** Ряд примера 6.1: шесть мест, пять зон, понедельник. */
async function exampleRow(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
): Promise<string> {
  const row = await saveRow(
    fixture.admin,
    {
      houseId: fixture.houseId,
      name: 'Общие зоны',
      type: 'common',
      weekday: 1,
      startDate: MONDAY,
      slots: fixture.beds.map((bedId) => ({ bedId })),
      zones: fixture.zones,
    },
    { executor: tx },
  );

  return row.id;
}

describe('генерация расписания', () => {
  it('пример 6.1: неделя 0 раскладывает пять зон по первым пяти слотам', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9501');
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const day = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: MONDAY },
        { executor: tx },
      );

      expect(day).toHaveLength(5);

      const bySlot = new Map<number, string>();
      for (const occurrence of day) {
        for (const assignment of occurrence.assignments) {
          bySlot.set(assignment.slotPosition ?? -1, occurrence.occurrence.areaId);
        }
      }

      expect(bySlot.get(0)).toBe(fixture.zones[0]?.areaId);
      expect(bySlot.get(4)).toBe(fixture.zones[4]?.areaId);
      // Шестой слот на неделе 0 отдыхает: назначения у него нет вовсе.
      expect(bySlot.has(5)).toBe(false);
    });
  });

  it('пример 6.1: на неделе 1 сетка сдвигается на один слот', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9502');
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const week = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: NEXT_MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );

      const bySlot = new Map<number, string>();
      for (const occurrence of week) {
        for (const assignment of occurrence.assignments) {
          bySlot.set(assignment.slotPosition ?? -1, occurrence.occurrence.areaId);
        }
      }

      // Слот 0 переходит с зала на кухню, слот 5 получает зал (§6.2).
      expect(bySlot.get(0)).toBe(fixture.zones[1]?.areaId);
      expect(bySlot.get(5)).toBe(fixture.zones[0]?.areaId);
      expect(bySlot.has(4)).toBe(false);
    });
  });

  it('четыре недели подряд: каждая зона убирается раз в неделю', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9503');
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, FOURTH_MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const month = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: FOURTH_MONDAY },
        { executor: tx },
      );

      expect(month).toHaveLength(20);

      for (const date of [MONDAY, NEXT_MONDAY, parseBusinessDate('2026-09-21'), FOURTH_MONDAY]) {
        const day = month.filter((item) => item.occurrence.date === date);
        const areas = day.map((item) => item.occurrence.areaId);

        expect(new Set(areas).size).toBe(5);
      }
    });
  });

  it('число назначений равно people_needed чек-листа (инвариант 8)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9504');

      // Двор требует двоих: столько назначений и должно появиться.
      const [yard] = await tx
        .insert(schema.areas)
        .values({ houseId: fixture.houseId, type: 'common', name: 'Двор' })
        .returning();
      const [yardChecklist] = await tx
        .insert(schema.areaChecklists)
        .values({
          areaId: yard?.id ?? '',
          type: 'regular',
          title: 'Двор',
          peopleNeeded: 2,
        })
        .returning();

      await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseId,
          name: 'Двор вдвоём',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
          slots: fixture.beds.slice(0, 3).map((bedId) => ({ bedId })),
          zones: [{ areaId: yard?.id ?? '', checklistId: yardChecklist?.id ?? '' }],
        },
        { executor: tx },
      );

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const [occurrence] = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: MONDAY },
        { executor: tx },
      );

      expect(occurrence?.assignments).toHaveLength(2);
      expect(occurrence?.assignments.map((item) => item.slotPosition).sort()).toEqual([0, 1]);
    });
  });

  it('повторная генерация того же периода не создаёт вторых занятий', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9505');
      await exampleRow(tx, fixture);

      const first = await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
        today: MONDAY,
      });
      const second = await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      expect(first.created).toBe(10);
      expect(second.created).toBe(0);

      const all = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );

      expect(all).toHaveLength(10);
    });
  });

  it('отменённое занятие повторная генерация не воскрешает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9506');
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const [first] = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: MONDAY },
        { executor: tx },
      );

      await tx
        .update(schema.rotationOccurrences)
        .set({ status: 'cancelled' })
        .where(eq(schema.rotationOccurrences.id, first?.occurrence.id ?? ''));

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const day = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: MONDAY },
        { executor: tx },
      );

      expect(day).toHaveLength(5);
      expect(
        day.find((item) => item.occurrence.id === first?.occurrence.id)?.occurrence.status,
      ).toBe('cancelled');
    });
  });

  it('прошлое не materialизуется задним числом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9507');
      await exampleRow(tx, fixture);

      // «Сегодня» — вторая неделя ряда: первая уже прошла и занятий не получит.
      await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
        today: NEXT_MONDAY,
      });

      const all = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );

      expect(all.every((item) => item.occurrence.date === NEXT_MONDAY)).toBe(true);
    });
  });

  it('выключенный ряд занятий не порождает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9508');
      const rowId = await exampleRow(tx, fixture);

      await tx
        .update(schema.rotationRows)
        .set({ isActive: false })
        .where(eq(schema.rotationRows.id, rowId));

      const result = await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      expect(result.created).toBe(0);
    });
  });

  it('жилец расписание не генерирует', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9509');
      await exampleRow(tx, fixture);

      await expect(
        generateSchedule(fixture.resident, fixture.houseId, MONDAY, {
          executor: tx,
          today: MONDAY,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('исполнители', () => {
  it('жилец места становится исполнителем своего слота', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9510');
      const userId = await fixture.moveIn(fixture.beds[0] ?? '', parseBusinessDate('2026-09-01'));
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const day = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: MONDAY },
        { executor: tx },
      );

      const assignments = day.flatMap((item) => item.assignments);
      const mine = assignments.find((item) => item.slotPosition === 0);

      expect(mine?.userId).toBe(userId);
      expect(mine?.state).toBe('assigned');
    });
  });

  it('пустующее место даёт needs_reassignment, а не молчаливую дыру (§6.3)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9511');
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const day = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: MONDAY },
        { executor: tx },
      );

      const assignments = day.flatMap((item) => item.assignments);

      expect(assignments).toHaveLength(5);
      expect(assignments.every((item) => item.state === 'needs_reassignment')).toBe(true);
      expect(assignments.every((item) => item.userId === null)).toBe(true);
    });
  });

  it('заселение внутри месяца пересчитывает будущие назначения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9512');
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      // Жилец въезжает после генерации — расписание о нём ещё не знает.
      const userId = await fixture.moveIn(fixture.beds[0] ?? '', NEXT_MONDAY);

      await refreshFutureAssignments(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
      });

      const before = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: MONDAY },
        { executor: tx },
      );
      const after = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: NEXT_MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );

      // Прошедшая неделя остаётся как была: её уже видели люди.
      expect(before.flatMap((item) => item.assignments).every((item) => item.userId === null)).toBe(
        true,
      );

      const mine = after
        .flatMap((item) => item.assignments)
        .find((item) => item.slotPosition === 0);
      expect(mine?.userId).toBe(userId);
      expect(mine?.state).toBe('assigned');
    });
  });

  it('выселение возвращает назначение в needs_reassignment', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9513');
      await fixture.moveIn(fixture.beds[0] ?? '', parseBusinessDate('2026-09-01'), NEXT_MONDAY);
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const after = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: NEXT_MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );

      // Место освобождается 14-го: на эту дату исполнителя у слота уже нет.
      const slot = after
        .flatMap((item) => item.assignments)
        .find((item) => item.slotPosition === 0);

      expect(slot?.userId).toBeNull();
      expect(slot?.state).toBe('needs_reassignment');
    });
  });

  it('заселение через сервис мест пересчитывает будущие ротации само', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9515');
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      // Проживание без места: жильца заводят, место дают отдельным действием.
      const [user] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77055150001',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();
      const [residency] = await tx
        .insert(schema.residencies)
        .values({
          orgId: fixture.orgId,
          userId: user?.id ?? '',
          houseId: fixture.houseId,
          status: 'active',
          moveInDate: NEXT_MONDAY,
        })
        .returning();

      await assignBedToResidency(
        fixture.admin,
        { residencyId: residency?.id ?? '', bedId: fixture.beds[0] ?? '', from: NEXT_MONDAY },
        { executor: tx, today: NEXT_MONDAY },
      );

      const week = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: NEXT_MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );
      const mine = week.flatMap((item) => item.assignments).find((item) => item.slotPosition === 0);

      expect(mine?.userId).toBe(user?.id);
      expect(mine?.state).toBe('assigned');
    });
  });

  it('освобождение места возвращает его ротации в «требует решения»', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9516');
      const [user] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77055160001',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();
      const [residency] = await tx
        .insert(schema.residencies)
        .values({
          orgId: fixture.orgId,
          userId: user?.id ?? '',
          houseId: fixture.houseId,
          status: 'active',
          moveInDate: parseBusinessDate('2026-09-01'),
        })
        .returning();
      await tx.insert(schema.bedAssignments).values({
        residencyId: residency?.id ?? '',
        bedId: fixture.beds[0] ?? '',
        price: 100_000,
        period: '[2026-09-01,)',
      });

      await exampleRow(tx, fixture);
      await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      await releaseBedOfResidency(fixture.admin, residency?.id ?? '', NEXT_MONDAY, {
        executor: tx,
        today: NEXT_MONDAY,
      });

      const week = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: NEXT_MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );
      const slot = week.flatMap((item) => item.assignments).find((item) => item.slotPosition === 0);

      expect(slot?.userId).toBeNull();
      expect(slot?.state).toBe('needs_reassignment');
    });
  });

  it('назначенный вручную исполнитель пересчётом не затирается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9514');
      const userId = await fixture.moveIn(fixture.beds[1] ?? '', parseBusinessDate('2026-09-01'));
      await exampleRow(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const week = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: NEXT_MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );
      const target = week
        .flatMap((item) => item.assignments)
        .find((item) => item.slotPosition === 0);

      await tx
        .update(schema.rotationAssignments)
        .set({ userId, source: 'manual', state: 'assigned', emptyReason: null })
        .where(eq(schema.rotationAssignments.id, target?.id ?? ''));

      await refreshFutureAssignments(fixture.admin, fixture.houseId, NEXT_MONDAY, {
        executor: tx,
      });

      const refreshed = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: NEXT_MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );
      const kept = refreshed
        .flatMap((item) => item.assignments)
        .find((item) => item.slotPosition === 0);

      expect(kept?.userId).toBe(userId);
      expect(kept?.source).toBe('manual');
    });
  });
});
