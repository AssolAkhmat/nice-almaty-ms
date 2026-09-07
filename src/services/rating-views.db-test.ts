import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { putRatingRule } from '@/db/repositories/rating';
import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { addRatingEvent } from './rating';
import { readHouseRating, readMyRatingCard, readResidentRating } from './rating-views';
import { ORG_SETTINGS, writeOrgSetting } from './settings';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Экраны рейтинга (docs/03-BUSINESS-RULES.md §5.6, модуль 8).
 *
 * Жилец видит только число, и то — пока суперадмин не скрыл рейтинг
 * от всех. Админ видит рейтинг жильцов дома, историю, долги и штрафы.
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
const NOW = parseInstant('2026-09-07T12:00:00+05:00');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `viw-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `viw-a-${suffix}` })
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

  async function resident(tag: string, firstName: string): Promise<string> {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7709${suffix}${tag}`, passwordHash: 'x', role: 'resident' })
      .returning();
    const userId = user?.id ?? '';

    await tx.insert(schema.residentProfiles).values({ userId, firstName, sex: 'male' });
    await tx
      .insert(schema.residencies)
      .values({ orgId, userId, houseId, status: 'active', moveInDate: '2026-09-01' });

    return userId;
  }

  const first = await resident('1', 'Азамат');
  const second = await resident('2', 'Данияр');

  const context = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: forHouse });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseId,
    first,
    second,
    superadmin: actor(context('superadmin', superadminUser?.id ?? '', null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    dweller: actor(context('resident', first, null)),
  };
}

describe('карточка жильца (§5.6)', () => {
  it('жилец видит своё число', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5801');

      await addRatingEvent(
        fixture.admin,
        { userId: fixture.first, type: 'help', reason: 'Помог' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      const card = await readMyRatingCard(fixture.dweller, { executor: tx, today: TODAY });

      expect(card).toEqual({ rating: 52, visible: true });
    });
  });

  it('скрытый суперадмином рейтинг жильцу не показывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5802');

      await writeOrgSetting(
        fixture.superadmin,
        ORG_SETTINGS.ratingVisibleToResidents.key,
        false,
        tx,
      );

      const card = await readMyRatingCard(fixture.dweller, { executor: tx, today: TODAY });

      expect(card?.visible).toBe(false);
      // Число не уезжает на клиент вместе с флагом: скрыто — значит скрыто.
      expect(card?.rating).toBeNull();
    });
  });

  it('у того, кто не живёт в доме, карточки нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5803');

      expect(await readMyRatingCard(fixture.admin, { executor: tx, today: TODAY })).toBeNull();
    });
  });
});

describe('экран админа (модуль 8)', () => {
  it('список жильцов дома с числом, долгами и штрафами', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5811');

      await putRatingRule(
        fixture.superadmin.context,
        {
          houseId: fixture.houseId,
          kind: 'admin_action',
          code: 'violation',
          config: { delta: -21 },
        },
        tx,
      );
      await addRatingEvent(
        fixture.admin,
        { userId: fixture.first, type: 'violation', reason: 'Шум' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      const rows = await readHouseRating(fixture.admin, fixture.houseId, {
        executor: tx,
        today: TODAY,
      });

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.name)).toEqual(['Азамат', 'Данияр']);
      expect(rows[0]?.rating).toBe(29);
      expect(rows[0]?.debts).toBe(2);
      expect(rows[0]?.finesPending).toBe(2_500);
      expect(rows[1]?.rating).toBe(50);
    });
  });

  it('карточка жильца показывает историю, пороги и штрафы', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5812');

      await addRatingEvent(
        fixture.admin,
        { userId: fixture.first, type: 'warning', reason: 'Опоздание' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      const view = await readResidentRating(fixture.admin, fixture.first, {
        executor: tx,
        today: TODAY,
      });

      expect(view.rating).toBe(47);
      expect(view.events).toHaveLength(1);
      expect(view.events[0]?.type).toBe('warning');
      expect(view.fines).toEqual([]);
      expect(view.thresholds.filter((row) => row.armed)).toHaveLength(view.thresholds.length);
    });
  });

  it('жилец не видит ни списка дома, ни чужой карточки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5813');

      await expect(
        readHouseRating(fixture.dweller, fixture.houseId, { executor: tx, today: TODAY }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        readResidentRating(fixture.dweller, fixture.first, { executor: tx, today: TODAY }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
