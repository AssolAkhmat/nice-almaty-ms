import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, type BusinessDate } from '@/lib/time';

import {
  cancelOccurrence,
  cancelRange,
  createExtraOccurrence,
  moveOccurrence,
  placeOnOccurrence,
  reassignAssignment,
  readCalendar,
  removeAssignment,
} from './rotation-calendar';
import { saveNorm } from './rotation-day-setup';
import { saveRow } from './rotation-rows';
import { generateSchedule } from './rotation-schedule';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Календарь ротаций (docs/03-BUSINESS-RULES.md §6.6, docs/04-MODULES/03-rotations.md).
 *
 * Проверяется то, чем админ правит расписание: перенос, отмена, ручное
 * назначение, внеплановая ротация и каникулы. И то, что жилец всё это
 * только видит.
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

const MONDAY = parseBusinessDate('2026-09-07');
const TUESDAY = parseBusinessDate('2026-09-08');
const NEXT_MONDAY = parseBusinessDate('2026-09-14');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `cal-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `cal-a-${suffix}` })
    .returning();
  const [otherHouse] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `cal-b-${suffix}` })
    .returning();

  const houseId = house?.id ?? '';
  const otherHouseId = otherHouse?.id ?? '';

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'living', name: 'Комната 1' })
    .returning();
  const [yard] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'common', name: 'Двор' })
    .returning();
  const [kitchen] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'common', name: 'Кухня' })
    .returning();

  async function checklist(areaId: string): Promise<string> {
    const [row] = await tx
      .insert(schema.areaChecklists)
      .values({ areaId, type: 'regular', title: 'Уборка', peopleNeeded: 1 })
      .returning();

    return row?.id ?? '';
  }

  const yardChecklist = await checklist(yard?.id ?? '');
  const kitchenChecklist = await checklist(kitchen?.id ?? '');

  const beds: string[] = [];
  for (let number = 1; number <= 3; number += 1) {
    const [bed] = await tx
      .insert(schema.beds)
      .values({
        houseId,
        areaId: room?.id ?? '',
        label: `М${String(number)}`,
        tier: 'lower',
        number,
      })
      .returning();
    beds.push(bed?.id ?? '');
  }

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  /** Жилец с местом: он и исполнитель, и читатель календаря. */
  async function resident(tag: string, bedId: string): Promise<string> {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7709${suffix}${tag}`, passwordHash: 'x', role: 'resident' })
      .returning();
    const [residency] = await tx
      .insert(schema.residencies)
      .values({
        orgId,
        userId: user?.id ?? '',
        houseId,
        status: 'active',
        moveInDate: '2026-09-01',
      })
      .returning();
    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId,
      price: 100_000,
      period: '[2026-09-01,)',
    });

    return user?.id ?? '';
  }

  const first = await resident('1', beds[0] ?? '');
  const second = await resident('2', beds[1] ?? '');

  /** Жилец соседнего дома: в исполнители чужой ротации не годится. */
  const [strangerUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7706${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  await tx.insert(schema.residencies).values({
    orgId,
    userId: strangerUser?.id ?? '',
    houseId: otherHouseId,
    status: 'active',
    moveInDate: '2026-09-01',
  });

  const context = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: forHouse });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseId,
    otherHouseId,
    yard: yard?.id ?? '',
    kitchen: kitchen?.id ?? '',
    yardChecklist,
    kitchenChecklist,
    beds,
    first,
    second,
    stranger: strangerUser?.id ?? '',
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    resident: actor(context('resident', first, null)),
    stranger_actor: actor(context('resident', strangerUser?.id ?? '', null)),
  };
}

/** Ряд из трёх мест и двух зон плюс сгенерированное расписание на две недели. */
async function scheduled(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
): Promise<void> {
  await saveRow(
    fixture.admin,
    {
      houseId: fixture.houseId,
      name: 'Общие зоны',
      type: 'common',
      weekday: 1,
      startDate: MONDAY,
      slots: fixture.beds.map((bedId) => ({ bedId })),
      zones: [
        { areaId: fixture.yard, checklistId: fixture.yardChecklist },
        { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
      ],
    },
    { executor: tx },
  );

  await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
    executor: tx,
    today: MONDAY,
  });
}

async function occurrenceOn(
  fixture: Awaited<ReturnType<typeof seed>>,
  tx: Transaction,
  date: BusinessDate,
  areaId: string,
) {
  const view = await readCalendar(
    fixture.admin,
    { from: date, to: date },
    { executor: tx, houseId: fixture.houseId },
  );

  return view.occurrences.find((item) => item.occurrence.areaId === areaId);
}

describe('чтение календаря', () => {
  it('админ видит занятия своего дома за период', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9601');
      await scheduled(tx, fixture);

      const week = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(week.houseId).toBe(fixture.houseId);
      expect(week.occurrences).toHaveLength(2);
    });
  });

  it('жилец видит календарь своего дома, не называя дом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9602');
      await scheduled(tx, fixture);

      const week = await readCalendar(
        fixture.resident,
        { from: MONDAY, to: MONDAY },
        { executor: tx },
      );

      expect(week.houseId).toBe(fixture.houseId);
      expect(week.occurrences).toHaveLength(2);
    });
  });

  it('жилец не читает календарь чужого дома, даже назвав его', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9603');
      await scheduled(tx, fixture);

      const week = await readCalendar(
        fixture.stranger_actor,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );

      // Дом берётся из проживания, а не из запроса: чужой дом просто пуст.
      expect(week.houseId).toBe(fixture.otherHouseId);
      expect(week.occurrences).toHaveLength(0);
    });
  });
});

describe('перенос занятия', () => {
  it('меняет дату, помнит прежнюю и не трогает номер недели', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9610');
      await scheduled(tx, fixture);

      const before = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      const moved = await moveOccurrence(fixture.admin, before?.occurrence.id ?? '', TUESDAY, {
        executor: tx,
      });

      expect(moved.date).toBe(TUESDAY);
      expect(moved.movedFromDate).toBe(MONDAY);
      // Номер недели живёт в занятии: перенос ряд не пересобирает (§6.6).
      expect(moved.cycleIndex).toBe(before?.occurrence.cycleIndex);
    });
  });

  it('перенос на день, где это занятие уже есть, отклоняется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9611');
      await scheduled(tx, fixture);

      const first = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);

      await expect(
        moveOccurrence(fixture.admin, first?.occurrence.id ?? '', NEXT_MONDAY, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('жилец занятия не переносит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9612');
      await scheduled(tx, fixture);

      const occurrence = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);

      await expect(
        moveOccurrence(fixture.resident, occurrence?.occurrence.id ?? '', TUESDAY, {
          executor: tx,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('отмена', () => {
  it('отменяет занятие вместе с его назначениями', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9620');
      await scheduled(tx, fixture);

      const occurrence = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      await cancelOccurrence(fixture.admin, occurrence?.occurrence.id ?? '', { executor: tx });

      const after = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);

      expect(after?.occurrence.status).toBe('cancelled');
      expect(after?.assignments.every((item) => item.state === 'cancelled')).toBe(true);
    });
  });

  it('каникулы отменяют весь диапазон дат', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9621');
      await scheduled(tx, fixture);

      const cancelled = await cancelRange(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );

      expect(cancelled).toBe(4);

      const all = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: NEXT_MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(all.occurrences.every((item) => item.occurrence.status === 'cancelled')).toBe(true);
    });
  });

  it('каникулы не трогают уже выполненное', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9622');
      await scheduled(tx, fixture);

      const done = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      await tx
        .update(schema.rotationOccurrences)
        .set({ status: 'done' })
        .where(eq(schema.rotationOccurrences.id, done?.occurrence.id ?? ''));

      const cancelled = await cancelRange(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: NEXT_MONDAY },
        { executor: tx },
      );

      expect(cancelled).toBe(3);

      const after = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      expect(after?.occurrence.status).toBe('done');
    });
  });
});

describe('ручное назначение', () => {
  it('админ ставит исполнителя, и назначение перестаёт ждать решения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9630');
      await scheduled(tx, fixture);

      const occurrence = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      const target = occurrence?.assignments[0];

      const updated = await reassignAssignment(fixture.admin, target?.id ?? '', fixture.second, {
        executor: tx,
      });

      expect(updated.userId).toBe(fixture.second);
      expect(updated.source).toBe('manual');
      expect(updated.state).toBe('assigned');
    });
  });

  it('снятие исполнителя возвращает назначение в «требует решения»', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9631');
      await scheduled(tx, fixture);

      const occurrence = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      const target = occurrence?.assignments[0];

      const updated = await reassignAssignment(fixture.admin, target?.id ?? '', null, {
        executor: tx,
      });

      expect(updated.userId).toBeNull();
      expect(updated.state).toBe('needs_reassignment');
    });
  });

  it('жилец чужого дома исполнителем не становится', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9632');
      await scheduled(tx, fixture);

      const occurrence = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      const target = occurrence?.assignments[0];

      await expect(
        reassignAssignment(fixture.admin, target?.id ?? '', fixture.stranger, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('жилец исполнителей не меняет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9633');
      await scheduled(tx, fixture);

      const occurrence = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      const target = occurrence?.assignments[0];

      await expect(
        reassignAssignment(fixture.resident, target?.id ?? '', fixture.first, { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('внеплановая ротация', () => {
  it('заводится на дату с указанными исполнителями', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9640');

      const extra = await createExtraOccurrence(
        fixture.admin,
        {
          houseId: fixture.houseId,
          areaId: fixture.yard,
          checklistId: fixture.yardChecklist,
          date: TUESDAY,
          userIds: [fixture.first, fixture.second],
        },
        { executor: tx },
      );

      const view = await readCalendar(
        fixture.admin,
        { from: TUESDAY, to: TUESDAY },
        { executor: tx, houseId: fixture.houseId },
      );
      const created = view.occurrences.find((item) => item.occurrence.id === extra.id);

      expect(created?.occurrence.type).toBe('extra');
      expect(created?.occurrence.createdBy).not.toBeNull();
      expect(created?.assignments.map((item) => item.userId).sort()).toEqual(
        [fixture.first, fixture.second].sort(),
      );
      expect(created?.assignments.every((item) => item.source === 'manual')).toBe(true);
    });
  });

  it('внеплановая без исполнителей ждёт решения, а не исчезает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9641');

      const extra = await createExtraOccurrence(
        fixture.admin,
        {
          houseId: fixture.houseId,
          areaId: fixture.yard,
          checklistId: fixture.yardChecklist,
          date: TUESDAY,
          userIds: [],
        },
        { executor: tx },
      );

      const view = await readCalendar(
        fixture.admin,
        { from: TUESDAY, to: TUESDAY },
        { executor: tx, houseId: fixture.houseId },
      );
      const created = view.occurrences.find((item) => item.occurrence.id === extra.id);

      expect(created?.assignments).toHaveLength(1);
      expect(created?.assignments[0]?.state).toBe('needs_reassignment');
    });
  });

  it('две внеплановые в один день на одну зону не мешают друг другу', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9642');

      const input = {
        houseId: fixture.houseId,
        areaId: fixture.yard,
        checklistId: fixture.yardChecklist,
        date: TUESDAY,
        userIds: [fixture.first],
      };

      await createExtraOccurrence(fixture.admin, input, { executor: tx });
      await createExtraOccurrence(fixture.admin, input, { executor: tx });

      const view = await readCalendar(
        fixture.admin,
        { from: TUESDAY, to: TUESDAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(view.occurrences).toHaveLength(2);
    });
  });

  it('жилец внеплановую не заводит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9643');

      await expect(
        createExtraOccurrence(
          fixture.resident,
          {
            houseId: fixture.houseId,
            areaId: fixture.yard,
            checklistId: fixture.yardChecklist,
            date: TUESDAY,
            userIds: [fixture.first],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

/**
 * Правки недели фазы 10 (`docs/tasks/PHASE-10.md` §2.6, §2.7): снять одного
 * исполнителя с зоны на дату и поставить человека на зону дня — в дырку
 * или сверх нормы, с галочкой «списать доп. ротацию».
 */
describe('правки недели: снять и поставить', () => {
  /** Норма §3: двор на двоих и кухня; третье место пустует — на кухне дырка. */
  async function yardForTwo(
    tx: Transaction,
    fixture: Awaited<ReturnType<typeof seed>>,
  ): Promise<void> {
    const row = await saveRow(
      fixture.admin,
      {
        houseId: fixture.houseId,
        name: 'Общие зоны',
        type: 'common',
        weekday: 1,
        startDate: MONDAY,
        slots: fixture.beds.map((bedId) => ({ bedId })),
        zones: [
          { areaId: fixture.yard, checklistId: fixture.yardChecklist },
          { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
        ],
      },
      { executor: tx },
    );

    await saveNorm(
      fixture.admin,
      {
        rowId: row.id,
        effectiveFrom: MONDAY,
        zones: [
          { areaId: fixture.yard, checklistId: fixture.yardChecklist, people: 2 },
          { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
        ],
      },
      { executor: tx, today: MONDAY },
    );

    await generateSchedule(fixture.admin, fixture.houseId, NEXT_MONDAY, {
      executor: tx,
      today: MONDAY,
    });
  }

  it('снять исполнителя со двора: двор 2 → 1, назначение уходит вместе с человеком', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9721');
      await yardForTwo(tx, fixture);

      const yard = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      expect(yard?.assignments).toHaveLength(2);
      expect(yard?.occurrence.peopleNeeded).toBe(2);

      const removed = yard?.assignments[1];
      const updated = await removeAssignment(fixture.admin, removed?.id ?? '', { executor: tx });

      expect(updated.peopleNeeded).toBe(1);

      const after = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      expect(after?.assignments).toHaveLength(1);
      expect(after?.assignments[0]?.id).not.toBe(removed?.id);

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, yard?.occurrence.id ?? ''));
      expect(entries.map((entry) => entry.action)).toContain('rotation.assignment_removed');
    });
  });

  it('следующая неделя идёт по норме: двор снова на двоих', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9722');
      await yardForTwo(tx, fixture);

      const yard = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      await removeAssignment(fixture.admin, yard?.assignments[1]?.id ?? '', { executor: tx });

      const next = await occurrenceOn(fixture, tx, NEXT_MONDAY, fixture.yard);
      expect(next?.occurrence.peopleNeeded).toBe(2);
      expect(next?.assignments).toHaveLength(2);
    });
  });

  it('последнего исполнителя не снять: зону на дату отменяют, а не обнуляют', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9723');
      await yardForTwo(tx, fixture);

      const kitchen = await occurrenceOn(fixture, tx, MONDAY, fixture.kitchen);
      expect(kitchen?.assignments).toHaveLength(1);

      await expect(
        removeAssignment(fixture.admin, kitchen?.assignments[0]?.id ?? '', { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('подтверждённое назначение не снимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9724');
      await yardForTwo(tx, fixture);

      const yard = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);
      const confirmed = yard?.assignments[0]?.id ?? '';

      await tx
        .update(schema.rotationAssignments)
        .set({ state: 'confirmed' })
        .where(eq(schema.rotationAssignments.id, confirmed));

      await expect(
        removeAssignment(fixture.admin, confirmed, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('поставить на зону закрывает дырку: назначение получает человека и галочку', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9725');
      await yardForTwo(tx, fixture);

      const kitchen = await occurrenceOn(fixture, tx, MONDAY, fixture.kitchen);
      expect(kitchen?.assignments[0]?.userId).toBeNull();

      const placed = await placeOnOccurrence(
        fixture.admin,
        { occurrenceId: kitchen?.occurrence.id ?? '', userId: fixture.first, writeOffDebt: true },
        { executor: tx },
      );

      expect(placed.id).toBe(kitchen?.assignments[0]?.id);
      expect(placed.userId).toBe(fixture.first);
      expect(placed.state).toBe('assigned');
      expect(placed.source).toBe('debt');
      expect(placed.writeOffDebt).toBe(true);
      expect(placed.emptyReason).toBeNull();

      const after = await occurrenceOn(fixture, tx, MONDAY, fixture.kitchen);
      expect(after?.assignments).toHaveLength(1);
      expect(after?.occurrence.peopleNeeded).toBe(1);

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, kitchen?.occurrence.id ?? ''));
      expect(entries.map((entry) => entry.action)).toContain('rotation.placed');
    });
  });

  it('поставить сверх нормы: у занятия становится на человека больше', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9726');
      await yardForTwo(tx, fixture);

      const kitchen = await occurrenceOn(fixture, tx, MONDAY, fixture.kitchen);
      const occurrenceId = kitchen?.occurrence.id ?? '';

      await placeOnOccurrence(
        fixture.admin,
        { occurrenceId, userId: fixture.first },
        { executor: tx },
      );
      const extra = await placeOnOccurrence(
        fixture.admin,
        { occurrenceId, userId: fixture.second },
        { executor: tx },
      );

      expect(extra.source).toBe('manual');
      expect(extra.writeOffDebt).toBe(false);

      const after = await occurrenceOn(fixture, tx, MONDAY, fixture.kitchen);
      expect(after?.assignments).toHaveLength(2);
      expect(after?.occurrence.peopleNeeded).toBe(2);
      expect(after?.assignments.map((item) => item.userId)).toEqual([
        fixture.first,
        fixture.second,
      ]);
    });
  });

  it('дважды на одну зону в один день не ставят', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9727');
      await yardForTwo(tx, fixture);

      const yard = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);

      await expect(
        placeOnOccurrence(
          fixture.admin,
          { occurrenceId: yard?.occurrence.id ?? '', userId: fixture.first },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('жилец другого дома на зону не встаёт, отменённое занятие людей не принимает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9728');
      await yardForTwo(tx, fixture);

      const kitchen = await occurrenceOn(fixture, tx, MONDAY, fixture.kitchen);
      const occurrenceId = kitchen?.occurrence.id ?? '';

      await expect(
        placeOnOccurrence(
          fixture.admin,
          { occurrenceId, userId: fixture.stranger },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      await cancelOccurrence(fixture.admin, occurrenceId, { executor: tx });

      await expect(
        placeOnOccurrence(fixture.admin, { occurrenceId, userId: fixture.first }, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('внеплановая с галочкой списания помнит её у назначения (§7)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9729');

      const occurrence = await createExtraOccurrence(
        fixture.admin,
        {
          houseId: fixture.houseId,
          areaId: fixture.yard,
          checklistId: fixture.yardChecklist,
          date: TUESDAY,
          userIds: [fixture.first],
          writeOffDebt: true,
        },
        { executor: tx },
      );

      const view = await occurrenceOn(fixture, tx, TUESDAY, fixture.yard);
      expect(view?.occurrence.id).toBe(occurrence.id);
      expect(view?.assignments[0]?.writeOffDebt).toBe(true);
      expect(view?.assignments[0]?.source).toBe('debt');
    });
  });

  it('замена исполнителя снимает галочку: списание принадлежит тому, кого ставили', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9730');
      await yardForTwo(tx, fixture);

      const kitchen = await occurrenceOn(fixture, tx, MONDAY, fixture.kitchen);
      const placed = await placeOnOccurrence(
        fixture.admin,
        { occurrenceId: kitchen?.occurrence.id ?? '', userId: fixture.first, writeOffDebt: true },
        { executor: tx },
      );

      const swapped = await reassignAssignment(fixture.admin, placed.id, fixture.second, {
        executor: tx,
      });

      expect(swapped.userId).toBe(fixture.second);
      expect(swapped.writeOffDebt).toBe(false);
      expect(swapped.source).toBe('manual');
    });
  });

  it('жилец не снимает и не ставит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9731');
      await yardForTwo(tx, fixture);

      const yard = await occurrenceOn(fixture, tx, MONDAY, fixture.yard);

      await expect(
        removeAssignment(fixture.resident, yard?.assignments[0]?.id ?? '', { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        placeOnOccurrence(
          fixture.resident,
          { occurrenceId: yard?.occurrence.id ?? '', userId: fixture.first },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
