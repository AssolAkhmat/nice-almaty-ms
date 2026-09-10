import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedRow } from '@/db/testing/rotation-row';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { closeRotationDay, ROTATIONS_CLOSE_DAY_JOB } from './rotation-close-day';
import { readCalendar } from './rotation-calendar';
import { confirmAssignment, setOccurrenceStatus } from './rotation-confirmation';
import { generateSchedule } from './rotation-schedule';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Автозакрытие дня (docs/03-BUSINESS-RULES.md §7).
 *
 * В 23:55 дня, следующего за днём ротации, неподтверждённое становится
 * «Не выполнена» с оценкой 1 и даёт +1 к долгу дополнительных ротаций.
 * Событие рейтинга — фаза 5: записывать его пока некуда.
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

/** Понедельник — день ротации; закрытие идёт вечером вторника. */
const MONDAY = parseBusinessDate('2026-09-07');
/** 23:55 вторника по Алматы: тот самый момент из §7. */
const TUESDAY_NIGHT = parseInstant('2026-09-08T23:55:00+05:00');
/** Тот же момент в UTC-сутках понедельника: граница суток проверяется явно. */
const MONDAY_NIGHT = parseInstant('2026-09-07T23:55:00+05:00');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `close-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7701${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `close-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'living', name: 'Комната 1' })
    .returning();
  const [yard] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'common', name: 'Двор' })
    .returning();

  const [checklist] = await tx
    .insert(schema.areaChecklists)
    .values({ areaId: yard?.id ?? '', type: 'regular', title: 'Двор', peopleNeeded: 1 })
    .returning();

  const [bed] = await tx
    .insert(schema.beds)
    .values({ houseId, areaId: room?.id ?? '', label: 'М1', tier: 'lower', number: 1 })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  const [workerUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: workerUser?.id ?? '',
      houseId,
      status: 'active',
      moveInDate: '2026-09-01',
    })
    .returning();
  await tx.insert(schema.bedAssignments).values({
    residencyId: residency?.id ?? '',
    bedId: bed?.id ?? '',
    price: 100_000,
    period: '[2026-09-01,)',
  });

  const context = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: forHouse });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });
  const admin = actor(context('admin', adminUser?.id ?? '', houseId));

  await seedRow(
    admin,
    {
      houseId,
      name: 'Двор',
      type: 'common',
      weekday: 1,
      startDate: MONDAY,
      bedIds: [bed?.id ?? ''],
      zones: [{ areaId: yard?.id ?? '', checklistId: checklist?.id ?? '' }],
    },
    { executor: tx },
  );
  await generateSchedule(admin, houseId, MONDAY, { executor: tx, today: MONDAY });

  const day = await readCalendar(admin, { from: MONDAY, to: MONDAY }, { executor: tx, houseId });

  return {
    orgId,
    houseId,
    occurrenceId: day.occurrences[0]?.occurrence.id ?? '',
    assignmentId: day.occurrences[0]?.assignments[0]?.id ?? '',
    workerId: workerUser?.id ?? '',
    superadminId: superadminUser?.id ?? '',
    admin,
    worker: actor(context('resident', workerUser?.id ?? '', null)),
  };
}

async function debtsOf(tx: Transaction, userId: string) {
  return tx.select().from(schema.rotationDebts).where(eq(schema.rotationDebts.userId, userId));
}

/**
 * Состояние конкретного назначения. Счётчик прогона считает всю сеть,
 * а в общей базе живут ещё и сидовые ротации: проверять надо своё
 * назначение, а не итог задания (инцидент I7).
 */
async function stateOf(tx: Transaction, assignmentId: string): Promise<string> {
  const [assignment] = await tx
    .select({ state: schema.rotationAssignments.state })
    .from(schema.rotationAssignments)
    .where(eq(schema.rotationAssignments.id, assignmentId));

  return assignment?.state ?? '';
}

describe('автозакрытие дня', () => {
  it('неподтверждённая вчерашняя ротация становится «не выполнена» с оценкой 1', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9901');

      await closeRotationDay({ executor: tx, instant: TUESDAY_NIGHT });

      const day = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );
      const assignment = day.occurrences[0]?.assignments[0];

      expect(assignment?.state).toBe('missed');
      expect(assignment?.score).toBe(1);
      expect(day.occurrences[0]?.occurrence.status).toBe('missed');
    });
  });

  it('за пропуск начисляется долг по дополнительной ротации', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9902');

      await closeRotationDay({ executor: tx, instant: TUESDAY_NIGHT });

      const debts = await debtsOf(tx, fixture.workerId);

      expect(debts).toHaveLength(1);
      expect(debts[0]?.sourceAssignmentId).toBe(fixture.assignmentId);
      // Долг не сгорает и живёт до 1 июля (§7).
      expect(debts[0]?.expiresAt).toBe('2027-07-01');
    });
  });

  it('подтверждённая ротация закрытием не трогается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9903');

      await confirmAssignment(
        fixture.worker,
        fixture.assignmentId,
        {},
        { executor: tx, instant: parseInstant('2026-09-07T18:00:00+05:00') },
      );

      await closeRotationDay({ executor: tx, instant: TUESDAY_NIGHT });

      expect(await stateOf(tx, fixture.assignmentId)).toBe('confirmed');
      expect(await debtsOf(tx, fixture.workerId)).toHaveLength(0);
    });
  });

  it('отменённая ротация не даёт ни оценки, ни долга', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9904');

      await setOccurrenceStatus(fixture.admin, fixture.occurrenceId, 'cancelled', { executor: tx });

      await closeRotationDay({ executor: tx, instant: TUESDAY_NIGHT });

      // Отменённое закрытие не трогает: назначение остаётся как было (§7).
      expect(await stateOf(tx, fixture.assignmentId)).toBe('assigned');
      expect(await debtsOf(tx, fixture.workerId)).toHaveLength(0);
    });
  });

  it('сегодняшняя ротация ещё не закрывается: у жильца весь завтрашний день', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9905');

      // 23:55 самого понедельника — ротация ещё сегодняшняя (§7).
      await closeRotationDay({ executor: tx, instant: MONDAY_NIGHT });

      expect(await stateOf(tx, fixture.assignmentId)).toBe('assigned');
      expect(await debtsOf(tx, fixture.workerId)).toHaveLength(0);
    });
  });

  it('назначение без исполнителя долга никому не даёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9906');

      await tx
        .update(schema.rotationAssignments)
        .set({ userId: null, state: 'needs_reassignment', emptyReason: 'empty_bed' })
        .where(eq(schema.rotationAssignments.id, fixture.assignmentId));

      await closeRotationDay({ executor: tx, instant: TUESDAY_NIGHT });

      expect(await stateOf(tx, fixture.assignmentId)).toBe('missed');
      expect(await debtsOf(tx, fixture.workerId)).toHaveLength(0);
    });
  });

  it('повторный прогон того же дня ничего не меняет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9907');

      const first = await closeRotationDay({ executor: tx, instant: TUESDAY_NIGHT });
      const second = await closeRotationDay({ executor: tx, instant: TUESDAY_NIGHT });

      expect(first.closed).toBe(1);
      expect(second.skipped).toBe(true);
      expect(await debtsOf(tx, fixture.workerId)).toHaveLength(1);
    });
  });

  it('прогон отмечается в журнале заданий', async () => {
    await inRollback(async (tx) => {
      await seed(tx, '9908');

      await closeRotationDay({ executor: tx, instant: TUESDAY_NIGHT });

      const [run] = await tx
        .select()
        .from(schema.jobRuns)
        .where(
          and(
            eq(schema.jobRuns.job, ROTATIONS_CLOSE_DAY_JOB),
            eq(schema.jobRuns.periodKey, MONDAY),
          ),
        );

      expect(run?.status).toBe('done');
    });
  });
});
