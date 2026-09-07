import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { confirmAssignment, markAssignment, setOccurrenceStatus } from './rotation-confirmation';
import { readCalendar } from './rotation-calendar';
import { saveRow } from './rotation-rows';
import { generateSchedule } from './rotation-schedule';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Подтверждение и оценка ротаций (docs/03-BUSINESS-RULES.md §7).
 *
 * Жилец подтверждает свою уборку сам и оценки не видит. Админ отмечает
 * за него и ставит оценку 1–10; всё это обратимо.
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
const MOMENT = parseInstant('2026-09-07T14:00:00+05:00');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `conf-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `conf-a-${suffix}` })
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
  const [otherBed] = await tx
    .insert(schema.beds)
    .values({ houseId, areaId: room?.id ?? '', label: 'М2', tier: 'upper', number: 2 })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

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

  const worker = await resident('1', bed?.id ?? '');
  const neighbour = await resident('2', otherBed?.id ?? '');

  const context = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: forHouse });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  const admin = actor(context('admin', adminUser?.id ?? '', houseId));

  await saveRow(
    admin,
    {
      houseId,
      name: 'Двор',
      type: 'common',
      weekday: 1,
      startDate: MONDAY,
      slots: [{ bedId: bed?.id ?? '' }, { bedId: otherBed?.id ?? '' }],
      zones: [{ areaId: yard?.id ?? '', checklistId: checklist?.id ?? '' }],
    },
    { executor: tx },
  );
  await generateSchedule(admin, houseId, MONDAY, { executor: tx, today: MONDAY });

  const day = await readCalendar(admin, { from: MONDAY, to: MONDAY }, { executor: tx, houseId });
  const assignment = day.occurrences[0]?.assignments[0];

  return {
    orgId,
    houseId,
    occurrenceId: day.occurrences[0]?.occurrence.id ?? '',
    assignmentId: assignment?.id ?? '',
    workerId: worker,
    neighbourId: neighbour,
    admin,
    worker: actor(context('resident', worker, null)),
    neighbour: actor(context('resident', neighbour, null)),
  };
}

describe('подтверждение жильцом', () => {
  it('жилец отмечает свою ротацию выполненной с комментарием', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9801');

      const confirmed = await confirmAssignment(
        fixture.worker,
        fixture.assignmentId,
        { note: 'Двор подметён' },
        { executor: tx, instant: MOMENT },
      );

      expect(confirmed.state).toBe('confirmed');
      expect(confirmed.confirmedAt).not.toBeNull();
      expect(confirmed.doneAt).not.toBeNull();
      expect(confirmed.note).toBe('Двор подметён');
      expect(confirmed.confirmedBy).toBe(fixture.workerId);
    });
  });

  it('время выполнения задаётся отдельно от времени подтверждения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9802');
      const earlier = parseInstant('2026-09-07T09:30:00+05:00');

      const confirmed = await confirmAssignment(
        fixture.worker,
        fixture.assignmentId,
        { doneAt: earlier },
        { executor: tx, instant: MOMENT },
      );

      expect(confirmed.doneAt?.toISOString()).toBe(earlier.toISOString());
      expect(confirmed.confirmedAt?.toISOString()).toBe(MOMENT.toISOString());
    });
  });

  it('подтверждение занятия — не своё дело соседа', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9803');

      await expect(
        confirmAssignment(fixture.neighbour, fixture.assignmentId, {}, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('оценку жилец не ставит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9804');

      await expect(
        markAssignment(
          fixture.worker,
          fixture.assignmentId,
          { state: 'confirmed', score: 10 },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('отменённую ротацию подтверждать нечем', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9805');

      await setOccurrenceStatus(fixture.admin, fixture.occurrenceId, 'cancelled', { executor: tx });

      await expect(
        confirmAssignment(fixture.worker, fixture.assignmentId, {}, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe('отметка и оценка админом', () => {
  it('админ отмечает за жильца и ставит оценку', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9810');

      const marked = await markAssignment(
        fixture.admin,
        fixture.assignmentId,
        { state: 'confirmed', score: 8 },
        { executor: tx, instant: MOMENT },
      );

      expect(marked.state).toBe('confirmed');
      expect(marked.score).toBe(8);
      expect(marked.scoredAt).not.toBeNull();
    });
  });

  it('оценка вне 1–10 не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9811');

      await expect(
        markAssignment(
          fixture.admin,
          fixture.assignmentId,
          { state: 'confirmed', score: 11 },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        markAssignment(
          fixture.admin,
          fixture.assignmentId,
          { state: 'confirmed', score: 0 },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('отметка «не выполнена» обратима', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9812');

      await markAssignment(
        fixture.admin,
        fixture.assignmentId,
        { state: 'missed', score: 1 },
        { executor: tx, instant: MOMENT },
      );

      const restored = await markAssignment(
        fixture.admin,
        fixture.assignmentId,
        { state: 'confirmed', score: 7 },
        { executor: tx, instant: MOMENT },
      );

      expect(restored.state).toBe('confirmed');
      expect(restored.score).toBe(7);
    });
  });

  it('статус занятия меняется в обе стороны', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9813');

      await setOccurrenceStatus(fixture.admin, fixture.occurrenceId, 'done', { executor: tx });
      const back = await setOccurrenceStatus(fixture.admin, fixture.occurrenceId, 'scheduled', {
        executor: tx,
      });

      expect(back.status).toBe('scheduled');
    });
  });

  it('статус занятия жилец не меняет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9814');

      await expect(
        setOccurrenceStatus(fixture.worker, fixture.occurrenceId, 'done', { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('видимость оценки (§7)', () => {
  it('админ оценку видит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9820');

      await markAssignment(
        fixture.admin,
        fixture.assignmentId,
        { state: 'confirmed', score: 9 },
        { executor: tx, instant: MOMENT },
      );

      const day = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );
      const assignment = day.occurrences[0]?.assignments.find(
        (item) => item.id === fixture.assignmentId,
      );

      expect(assignment?.score).toBe(9);
    });
  });

  it('жилец оценки не видит — ни своей, ни соседской', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9821');

      await markAssignment(
        fixture.admin,
        fixture.assignmentId,
        { state: 'confirmed', score: 9 },
        { executor: tx, instant: MOMENT },
      );

      const day = await readCalendar(
        fixture.worker,
        { from: MONDAY, to: MONDAY },
        { executor: tx },
      );
      const assignments = day.occurrences.flatMap((item) => item.assignments);

      expect(assignments.length).toBeGreaterThan(0);
      expect(assignments.every((item) => item.score === null)).toBe(true);
      // Кто поставил оценку и когда — тоже не его дело.
      expect(assignments.every((item) => item.scoredBy === null)).toBe(true);
    });
  });
});
