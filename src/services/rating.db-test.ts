import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { putRatingRule } from '@/db/repositories/rating';
import { seedRow } from '@/db/testing/rotation-row';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { readCalendar } from './rotation-calendar';
import { closeRotationDay } from './rotation-close-day';
import { markAssignment, setOccurrenceStatus } from './rotation-confirmation';
import { generateSchedule } from './rotation-schedule';
import { addRatingEvent, readRating, readRatingHistory } from './rating';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * События рейтинга (docs/03-BUSINESS-RULES.md §5.1–5.2, §7).
 *
 * Оценка уборки и действие админа дают событие с дельтой из правил;
 * число рейтинга складывается из событий года, начинающегося 1 июля.
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

const TODAY = parseBusinessDate('2026-09-07');
const MONDAY = parseBusinessDate('2026-09-14');
const NOW = parseInstant('2026-09-07T12:00:00+05:00');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rat-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `rat-a-${suffix}` })
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

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  async function resident(tag: string, number: number): Promise<{ userId: string; bedId: string }> {
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

    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId: bed?.id ?? '',
      price: 100_000,
      period: '[2026-09-01,)',
    });

    return { userId: user?.id ?? '', bedId: bed?.id ?? '' };
  }

  const first = await resident('1', 1);
  const second = await resident('2', 2);

  const context = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: forHouse });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseId,
    yard: yard?.id ?? '',
    checklist: checklist?.id ?? '',
    first,
    second,
    superadmin: actor(context('superadmin', superadminUser?.id ?? '', null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    dweller: actor(context('resident', first.userId, null)),
  };
}

/** Ряд общих зон с одним местом: 14 сентября убирает первый жилец. */
async function scheduledAssignment(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
): Promise<string> {
  await seedRow(
    fixture.admin,
    {
      houseId: fixture.houseId,
      name: 'Общие зоны',
      type: 'common',
      weekday: 1,
      startDate: MONDAY,
      bedIds: [fixture.first.bedId],
      zones: [{ areaId: fixture.yard, checklistId: fixture.checklist }],
    },
    { executor: tx },
  );

  await generateSchedule(fixture.admin, fixture.houseId, MONDAY, { executor: tx, today: TODAY });

  const day = await readCalendar(
    fixture.admin,
    { from: MONDAY, to: MONDAY },
    { executor: tx, houseId: fixture.houseId },
  );

  return day.occurrences[0]?.assignments[0]?.id ?? '';
}

describe('события за оценку уборки (§5.2, §7)', () => {
  it('оценка админа даёт событие с дельтой из правил', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5501');
      const assignmentId = await scheduledAssignment(tx, fixture);

      await markAssignment(
        fixture.admin,
        assignmentId,
        { state: 'confirmed', score: 9 },
        { executor: tx, instant: NOW },
      );

      const history = await readRatingHistory(fixture.admin, fixture.first.userId, {
        executor: tx,
        today: MONDAY,
      });

      expect(history).toHaveLength(1);
      expect(history[0]?.type).toBe('score:9');
      expect(history[0]?.delta).toBe(2);
      expect(
        await readRating(fixture.admin, fixture.first.userId, { executor: tx, today: MONDAY }),
      ).toBe(52);
    });
  });

  it('переоценка задним числом переписывает дельту, а не добавляет вторую', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5502');
      const assignmentId = await scheduledAssignment(tx, fixture);

      await markAssignment(
        fixture.admin,
        assignmentId,
        { state: 'confirmed', score: 9 },
        { executor: tx, instant: NOW },
      );
      await markAssignment(
        fixture.admin,
        assignmentId,
        { state: 'confirmed', score: 5 },
        { executor: tx, instant: NOW },
      );

      const history = await readRatingHistory(fixture.admin, fixture.first.userId, {
        executor: tx,
        today: MONDAY,
      });

      expect(history).toHaveLength(1);
      expect(history[0]?.delta).toBe(-2);
      expect(
        await readRating(fixture.admin, fixture.first.userId, { executor: tx, today: MONDAY }),
      ).toBe(48);
    });
  });

  it('отменённое занятие влияния на рейтинг не имеет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5503');
      const assignmentId = await scheduledAssignment(tx, fixture);

      await markAssignment(
        fixture.admin,
        assignmentId,
        { state: 'missed', score: 2 },
        { executor: tx, instant: NOW },
      );

      const [assignment] = await tx
        .select({ occurrenceId: schema.rotationAssignments.occurrenceId })
        .from(schema.rotationAssignments)
        .where(eq(schema.rotationAssignments.id, assignmentId));

      await setOccurrenceStatus(fixture.admin, assignment?.occurrenceId ?? '', 'cancelled', {
        executor: tx,
        instant: NOW,
      });

      expect(
        await readRating(fixture.admin, fixture.first.userId, { executor: tx, today: MONDAY }),
      ).toBe(50);
    });
  });

  it('автозакрытие дня начисляет дельту за оценку 1', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5504');
      await scheduledAssignment(tx, fixture);

      // Запуск 15 сентября закрывает 14-е — день уборки.
      await closeRotationDay({ executor: tx, instant: parseInstant('2026-09-15T23:55:00+05:00') });

      const history = await readRatingHistory(fixture.admin, fixture.first.userId, {
        executor: tx,
        today: MONDAY,
      });

      expect(history).toHaveLength(1);
      expect(history[0]?.type).toBe('score:1');
      expect(history[0]?.delta).toBe(-2);
    });
  });

  it('правило дома сильнее сетевого', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5505');
      const assignmentId = await scheduledAssignment(tx, fixture);

      await putRatingRule(
        fixture.superadmin.context,
        { kind: 'score_delta', houseId: null, code: 'score:9', config: { score: 9, delta: 5 } },
        tx,
      );
      await putRatingRule(
        fixture.superadmin.context,
        {
          kind: 'score_delta',
          houseId: fixture.houseId,
          code: 'score:9',
          config: { score: 9, delta: 7 },
        },
        tx,
      );

      await markAssignment(
        fixture.admin,
        assignmentId,
        { state: 'confirmed', score: 9 },
        { executor: tx, instant: NOW },
      );

      expect(
        await readRating(fixture.admin, fixture.first.userId, { executor: tx, today: MONDAY }),
      ).toBe(57);
    });
  });
});

describe('действия админа (§5.2)', () => {
  it('событие с причиной меняет рейтинг и попадает в аудит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5511');

      const event = await addRatingEvent(
        fixture.admin,
        { userId: fixture.first.userId, type: 'warning', reason: 'Шум после 23:00' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      expect(event.delta).toBe(-3);
      expect(
        await readRating(fixture.admin, fixture.first.userId, { executor: tx, today: TODAY }),
      ).toBe(47);

      const audit = await tx
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.entityType, 'rating_event'),
            eq(schema.auditLog.entityId, event.id),
          ),
        );

      expect(audit).toHaveLength(1);
    });
  });

  it('причина обязательна', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5512');

      await expect(
        addRatingEvent(
          fixture.admin,
          { userId: fixture.first.userId, type: 'violation', reason: '   ' },
          { executor: tx, today: TODAY, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('неизвестное действие не начисляется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5513');

      await expect(
        addRatingEvent(
          fixture.admin,
          { userId: fixture.first.userId, type: 'medal', reason: 'За выслугу' },
          { executor: tx, today: TODAY, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('жилец событий не ставит — ни себе, ни соседу', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5514');

      await expect(
        addRatingEvent(
          fixture.dweller,
          { userId: fixture.first.userId, type: 'help', reason: 'Помог сам себе' },
          { executor: tx, today: TODAY, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Сосед для жильца неотличим от несуществующего (P1-1): по отказу
      // в правах он узнал бы, что такой человек в сети есть.
      await expect(
        addRatingEvent(
          fixture.dweller,
          { userId: fixture.second.userId, type: 'help', reason: 'Помог' },
          { executor: tx, today: TODAY, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('число рейтинга (§5.1, §5.6)', () => {
  it('события прошлого года в сегодняшнее число не входят', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5521');

      await addRatingEvent(
        fixture.admin,
        { userId: fixture.first.userId, type: 'reprimand', reason: 'Старое' },
        { executor: tx, today: parseBusinessDate('2026-06-30'), instant: NOW },
      );

      expect(
        await readRating(fixture.admin, fixture.first.userId, { executor: tx, today: TODAY }),
      ).toBe(50);
      expect(
        await readRating(fixture.admin, fixture.first.userId, {
          executor: tx,
          today: parseBusinessDate('2026-06-30'),
        }),
      ).toBe(45);
    });
  });

  it('жилец видит своё число и не видит чужого', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5522');

      await addRatingEvent(
        fixture.admin,
        { userId: fixture.first.userId, type: 'help', reason: 'Помог с переездом' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      expect(
        await readRating(fixture.dweller, fixture.first.userId, { executor: tx, today: TODAY }),
      ).toBe(52);
      await expect(
        readRating(fixture.dweller, fixture.second.userId, { executor: tx, today: TODAY }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('истории жилец не видит даже своей (§7)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5523');

      await expect(
        readRatingHistory(fixture.dweller, fixture.first.userId, { executor: tx, today: TODAY }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
