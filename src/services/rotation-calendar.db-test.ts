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
  reassignAssignment,
  readCalendar,
} from './rotation-calendar';
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
