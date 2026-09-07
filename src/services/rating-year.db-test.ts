import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { putRatingRule } from '@/db/repositories/rating';
import { listRotationDebts } from '@/db/repositories/rotations';
import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { addRatingEvent, readRating } from './rating';
import { resetRatingYear } from './rating-year';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Сброс года рейтинга (docs/03-BUSINESS-RULES.md §5.1, §7).
 *
 * 1 июля рейтинг возвращается к 50, долги по дополнительным ротациям
 * сгорают, взведённые пороги снимаются заново.
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

/** Июнь 2027 — конец года рейтинга; сброс приходит в ночь на 1 июля. */
const JUNE = parseBusinessDate('2027-06-20');
const JUNE_NOW = parseInstant('2027-06-20T12:00:00+05:00');
const RESET_AT = parseInstant('2027-07-01T00:10:00+05:00');
const JULY = parseBusinessDate('2027-07-01');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `yer-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `yer-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();
  const [dwellerUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  await tx.insert(schema.residencies).values({
    orgId,
    userId: dwellerUser?.id ?? '',
    houseId,
    status: 'active',
    moveInDate: '2027-01-01',
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
    userId: dwellerUser?.id ?? '',
    superadmin: actor(context('superadmin', superadminUser?.id ?? '', null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
  };
}

/** Роняем рейтинг до 29: срабатывают пороги 40 и 30, копятся долги и штраф. */
async function fallBelowThirty(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
): Promise<void> {
  await putRatingRule(
    fixture.superadmin.context,
    { houseId: fixture.houseId, kind: 'admin_action', code: 'violation', config: { delta: -21 } },
    tx,
  );
  await addRatingEvent(
    fixture.admin,
    { userId: fixture.userId, type: 'violation', reason: 'Шум' },
    { executor: tx, today: JUNE, instant: JUNE_NOW },
  );
}

describe('сброс года рейтинга (§5.1)', () => {
  it('после 1 июля рейтинг снова 50', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5901');
      await fallBelowThirty(tx, fixture);

      expect(await readRating(fixture.admin, fixture.userId, { executor: tx, today: JUNE })).toBe(
        29,
      );

      await resetRatingYear({ executor: tx, instant: RESET_AT });

      expect(await readRating(fixture.admin, fixture.userId, { executor: tx, today: JULY })).toBe(
        50,
      );
    });
  });

  it('долги по дополнительным ротациям сгорают', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5902');
      await fallBelowThirty(tx, fixture);

      expect(
        await listRotationDebts(fixture.admin.context, { userIds: [fixture.userId], on: JUNE }, tx),
      ).toHaveLength(2);

      await resetRatingYear({ executor: tx, instant: RESET_AT });

      expect(
        await listRotationDebts(fixture.admin.context, { userIds: [fixture.userId], on: JULY }, tx),
      ).toHaveLength(0);
    });
  });

  it('сработавшие пороги взводятся заново', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5903');
      await fallBelowThirty(tx, fixture);

      const before = await tx
        .select()
        .from(schema.ratingThresholdStates)
        .where(eq(schema.ratingThresholdStates.userId, fixture.userId));

      expect(before.filter((state) => !state.armed).length).toBeGreaterThan(0);

      await resetRatingYear({ executor: tx, instant: RESET_AT });

      const after = await tx
        .select()
        .from(schema.ratingThresholdStates)
        .where(eq(schema.ratingThresholdStates.userId, fixture.userId));

      expect(after.every((state) => state.armed)).toBe(true);
    });
  });

  it('в истории остаётся отметка о новом годе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5904');
      await fallBelowThirty(tx, fixture);

      await resetRatingYear({ executor: tx, instant: RESET_AT });

      const events = await tx
        .select()
        .from(schema.ratingEvents)
        .where(eq(schema.ratingEvents.userId, fixture.userId));
      const reset = events.filter((event) => event.type === 'year_reset');

      expect(reset).toHaveLength(1);
      expect(reset[0]?.delta).toBe(0);
      expect(reset[0]?.periodStart).toBe('2027-07-01');
    });
  });

  it('повторный прогон того же года ничего не делает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5905');
      await fallBelowThirty(tx, fixture);

      const first = await resetRatingYear({ executor: tx, instant: RESET_AT });
      const second = await resetRatingYear({ executor: tx, instant: RESET_AT });

      expect(first.skipped).toBe(false);
      expect(second.skipped).toBe(true);

      const events = await tx
        .select()
        .from(schema.ratingEvents)
        .where(eq(schema.ratingEvents.userId, fixture.userId));

      expect(events.filter((event) => event.type === 'year_reset')).toHaveLength(1);
    });
  });

  it('не 1 июля задание не сбрасывает ничего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5906');
      await fallBelowThirty(tx, fixture);

      const result = await resetRatingYear({ executor: tx, instant: JUNE_NOW });

      expect(result.skipped).toBe(true);
      expect(await readRating(fixture.admin, fixture.userId, { executor: tx, today: JUNE })).toBe(
        29,
      );
    });
  });
});
