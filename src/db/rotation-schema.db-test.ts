import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';

import type { Database, Transaction } from './client';

/**
 * Схема ротаций фазы 10 (`docs/tasks/PHASE-10.md` §4): версии состава и нормы,
 * число людей занятия, причина пустого назначения, долг со знаком.
 *
 * Проверяются те правила, которые обязана держать сама база: их нарушение
 * приходит из чужого кода, из бота или из руки в SQL Editor, и приложение
 * о нём не узнает. Логика раскладки живёт в `src/domain/rotation-day.ts`.
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

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }

  return parts.join(' | ');
}

/** Текст отказа базы: пустая строка означает, что запись прошла. */
async function failureText(
  tx: Transaction,
  body: (inner: Transaction) => Promise<unknown>,
): Promise<string> {
  try {
    await tx.transaction(async (inner) => {
      await body(inner);
    });

    return '';
  } catch (error) {
    return errorChain(error);
  }
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rot-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом ротаций', slug: `rot-house-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'living', name: 'Комната 1' })
    .returning();
  const [secondRoom] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'living', name: 'Комната 2' })
    .returning();
  const [yard] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'common', name: 'Двор' })
    .returning();
  const roomId = room?.id ?? '';
  const secondRoomId = secondRoom?.id ?? '';
  const yardId = yard?.id ?? '';

  const [checklist] = await tx
    .insert(schema.areaChecklists)
    .values({ areaId: yardId, type: 'regular', title: 'Двор', peopleNeeded: 2 })
    .returning();

  const [firstBed] = await tx
    .insert(schema.beds)
    .values({ houseId, areaId: roomId, label: '1', tier: 'lower', number: 1 })
    .returning();
  const [secondBed] = await tx
    .insert(schema.beds)
    .values({ houseId, areaId: roomId, label: '2', tier: 'upper', number: 1 })
    .returning();

  const [resident] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7701000${suffix}`,
      passwordHash: 'hash',
      role: 'resident',
    })
    .returning();

  return {
    orgId,
    houseId,
    roomId,
    secondRoomId,
    yardId,
    checklistId: checklist?.id ?? '',
    firstBedId: firstBed?.id ?? '',
    secondBedId: secondBed?.id ?? '',
    userId: resident?.id ?? '',
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function insertRow(
  tx: Transaction,
  fixture: Fixture,
  values: Partial<schema.NewRotationRow> = {},
): Promise<string> {
  const [row] = await tx
    .insert(schema.rotationRows)
    .values({
      orgId: fixture.orgId,
      houseId: fixture.houseId,
      name: 'Среда',
      type: 'common',
      weekday: 3,
      startDate: '2026-09-09',
      ...values,
    })
    .returning();

  return row?.id ?? '';
}

async function insertRoster(tx: Transaction, rowId: string, effectiveFrom = '2026-09-09') {
  const [roster] = await tx
    .insert(schema.rotationRowRosters)
    .values({ rowId, effectiveFrom })
    .returning();

  return roster?.id ?? '';
}

async function insertNorm(tx: Transaction, rowId: string, effectiveFrom = '2026-09-09') {
  const [norm] = await tx
    .insert(schema.rotationDayNorms)
    .values({ rowId, effectiveFrom })
    .returning();

  return norm?.id ?? '';
}

describe('ряд ротаций', () => {
  it('на дом приходится один действующий ряд общих зон в день недели', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2001');
      await insertRow(tx, fixture);

      const failure = await failureText(tx, (inner) => insertRow(inner, fixture));

      expect(failure).toContain('rotation_rows_common_weekday_unique');
    });
  });

  it('снятый с работы ряд не мешает завести на тот же день новый', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2002');
      await insertRow(tx, fixture, { isActive: false });

      const failure = await failureText(tx, (inner) => insertRow(inner, fixture));

      expect(failure).toBe('');
    });
  });

  it('комнатных рядов на воскресенье столько же, сколько комнат', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2003');
      await insertRow(tx, fixture, {
        type: 'room',
        weekday: 0,
        name: 'Комната 1',
        roomAreaId: fixture.roomId,
      });

      const failure = await failureText(tx, (inner) =>
        insertRow(inner, fixture, {
          type: 'room',
          weekday: 0,
          name: 'Комната 2',
          roomAreaId: fixture.secondRoomId,
        }),
      );

      expect(failure).toBe('');
    });
  });

  it('комнатный ряд без комнаты не заводится', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2004');

      const failure = await failureText(tx, (inner) =>
        insertRow(inner, fixture, { type: 'room', weekday: 0 }),
      );

      expect(failure).toContain('rotation_rows_room_has_area');
    });
  });

  it('у ряда общих зон комнаты быть не может', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2005');

      const failure = await failureText(tx, (inner) =>
        insertRow(inner, fixture, { roomAreaId: fixture.roomId }),
      );

      expect(failure).toContain('rotation_rows_room_has_area');
    });
  });
});

describe('версии состава ряда', () => {
  it('на одну дату вступления приходится одна версия состава', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2011');
      const rowId = await insertRow(tx, fixture);
      await insertRoster(tx, rowId);

      const failure = await failureText(tx, (inner) => insertRoster(inner, rowId));

      expect(failure).toContain('rotation_row_rosters_row_date_unique');
    });
  });

  it('место входит в версию состава один раз: иначе один жилец получит две зоны', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2012');
      const rosterId = await insertRoster(tx, await insertRow(tx, fixture));

      await tx
        .insert(schema.rotationRowRosterSlots)
        .values({ rosterId, position: 0, bedId: fixture.firstBedId });

      const failure = await failureText(tx, (inner) =>
        inner
          .insert(schema.rotationRowRosterSlots)
          .values({ rosterId, position: 1, bedId: fixture.firstBedId }),
      );

      expect(failure).toContain('rotation_row_roster_slots_bed_unique');
    });
  });

  it('позиция в версии состава занята одним местом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2013');
      const rosterId = await insertRoster(tx, await insertRow(tx, fixture));

      await tx
        .insert(schema.rotationRowRosterSlots)
        .values({ rosterId, position: 0, bedId: fixture.firstBedId });

      const failure = await failureText(tx, (inner) =>
        inner
          .insert(schema.rotationRowRosterSlots)
          .values({ rosterId, position: 0, bedId: fixture.secondBedId }),
      );

      expect(failure).toContain('rotation_row_roster_slots_position_unique');
    });
  });

  it('версии одного ряда на разные даты живут рядом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2014');
      const rowId = await insertRow(tx, fixture);
      await insertRoster(tx, rowId);

      const failure = await failureText(tx, (inner) => insertRoster(inner, rowId, '2026-10-21'));

      expect(failure).toBe('');
    });
  });
});

describe('версии нормы дня', () => {
  it('на одну дату вступления приходится одна норма', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2021');
      const rowId = await insertRow(tx, fixture);
      await insertNorm(tx, rowId);

      const failure = await failureText(tx, (inner) => insertNorm(inner, rowId));

      expect(failure).toContain('rotation_day_norms_row_date_unique');
    });
  });

  it('зона входит в норму один раз', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2022');
      const normId = await insertNorm(tx, await insertRow(tx, fixture));

      await tx.insert(schema.rotationDayNormZones).values({
        normId,
        position: 0,
        areaId: fixture.yardId,
        checklistId: fixture.checklistId,
        people: 2,
      });

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.rotationDayNormZones).values({
          normId,
          position: 1,
          areaId: fixture.yardId,
          checklistId: fixture.checklistId,
          people: 1,
        }),
      );

      expect(failure).toContain('rotation_day_norm_zones_area_unique');
    });
  });

  it('число людей зоны — от единицы: ноль означал бы зону, которую никто не убирает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2023');
      const normId = await insertNorm(tx, await insertRow(tx, fixture));

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.rotationDayNormZones).values({
          normId,
          position: 0,
          areaId: fixture.yardId,
          checklistId: fixture.checklistId,
          people: 0,
        }),
      );

      expect(failure).toContain('rotation_day_norm_zones_people_positive');
    });
  });
});

describe('занятие и назначение', () => {
  async function insertOccurrence(
    tx: Transaction,
    fixture: Fixture,
    values: Partial<schema.NewRotationOccurrence> = {},
  ): Promise<string> {
    const [occurrence] = await tx
      .insert(schema.rotationOccurrences)
      .values({
        orgId: fixture.orgId,
        houseId: fixture.houseId,
        areaId: fixture.yardId,
        checklistId: fixture.checklistId,
        date: '2026-09-13',
        type: 'regular',
        ...values,
      })
      .returning();

    return occurrence?.id ?? '';
  }

  it('число людей занятия — от единицы', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2031');

      const failure = await failureText(tx, (inner) =>
        insertOccurrence(inner, fixture, { peopleNeeded: 0 }),
      );

      expect(failure).toContain('rotation_occurrences_people_positive');
    });
  });

  it('назначение без исполнителя обязано назвать причину', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2032');
      const occurrenceId = await insertOccurrence(tx, fixture);

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.rotationAssignments).values({ occurrenceId, userId: null }),
      );

      expect(failure).toContain('rotation_assignments_empty_has_reason');
    });
  });

  it('у назначения с исполнителем причины пустоты не бывает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2033');
      const occurrenceId = await insertOccurrence(tx, fixture);

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.rotationAssignments).values({
          occurrenceId,
          userId: fixture.userId,
          emptyReason: 'absent',
        }),
      );

      expect(failure).toContain('rotation_assignments_empty_has_reason');
    });
  });

  it('дырка недопуска помнит, кто стоял в очереди, и списание долга по умолчанию выключено', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2034');
      const occurrenceId = await insertOccurrence(tx, fixture);

      const [assignment] = await tx
        .insert(schema.rotationAssignments)
        .values({
          occurrenceId,
          userId: null,
          emptyReason: 'not_eligible',
          queuedUserId: fixture.userId,
        })
        .returning();

      expect(assignment?.queuedUserId).toBe(fixture.userId);
      expect(assignment?.writeOffDebt).toBe(false);
    });
  });
});

describe('долг со знаком', () => {
  it('строка долга ходит шагом в единицу: плюс один или минус один', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2041');

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.rotationDebts).values({
          userId: fixture.userId,
          reason: 'не выполнена',
          delta: 2,
          expiresAt: '2027-07-01',
        }),
      );

      expect(failure).toContain('rotation_debts_delta_step');
    });
  });

  it('списание пишется той же книгой, но со знаком минус', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2042');

      const [debt] = await tx
        .insert(schema.rotationDebts)
        .values({
          userId: fixture.userId,
          reason: 'доп. ротация выполнена',
          delta: -1,
          expiresAt: '2027-07-01',
        })
        .returning();

      expect(debt?.delta).toBe(-1);
    });
  });

  it('начисление по умолчанию — плюс один', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2043');

      const [debt] = await tx
        .insert(schema.rotationDebts)
        .values({ userId: fixture.userId, reason: 'не выполнена', expiresAt: '2027-07-01' })
        .returning();

      expect(debt?.delta).toBe(1);
    });
  });
});
