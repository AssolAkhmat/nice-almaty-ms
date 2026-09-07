import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, ValidationError } from '@/lib/errors';

import { copyRatingRules, readRatingRuleTable, saveRatingRule } from './rating-rules';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Редактор правил рейтинга (docs/03-BUSINESS-RULES.md §5.5).
 *
 * Правила живут на уровне сети с переопределением на дом. Правит их
 * суперадмин; расчётное ядро читает результат, а не код экрана.
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

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rul-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `rul-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `rul-b-${suffix}` })
    .returning();

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7707${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseA?.id ?? null,
    })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseA: houseA?.id ?? '',
    houseB: houseB?.id ?? '',
    superadmin: actor(context('superadmin', superadminUser?.id ?? '', null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseA?.id ?? null)),
  };
}

describe('редактор правил (§5.5)', () => {
  it('правила правит суперадмин, админ дома — нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5701');

      await expect(
        saveRatingRule(
          fixture.admin,
          {
            houseId: fixture.houseA,
            kind: 'score_delta',
            code: 'score:10',
            config: { score: 10, delta: 9 },
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await saveRatingRule(
        fixture.superadmin,
        { houseId: null, kind: 'score_delta', code: 'score:10', config: { score: 10, delta: 4 } },
        { executor: tx },
      );

      const table = await readRatingRuleTable(fixture.superadmin, null, { executor: tx });

      expect(table.rules.scoreDeltas[10]).toBe(4);
    });
  });

  it('переопределение дома не трогает сеть', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5702');

      await saveRatingRule(
        fixture.superadmin,
        { houseId: null, kind: 'admin_action', code: 'violation', config: { delta: -2 } },
        { executor: tx },
      );
      await saveRatingRule(
        fixture.superadmin,
        { houseId: fixture.houseA, kind: 'admin_action', code: 'violation', config: { delta: -7 } },
        { executor: tx },
      );

      const network = await readRatingRuleTable(fixture.superadmin, null, { executor: tx });
      const house = await readRatingRuleTable(fixture.superadmin, fixture.houseA, {
        executor: tx,
      });
      const other = await readRatingRuleTable(fixture.superadmin, fixture.houseB, {
        executor: tx,
      });

      expect(network.rules.actionDeltas.violation).toBe(-2);
      expect(house.rules.actionDeltas.violation).toBe(-7);
      expect(other.rules.actionDeltas.violation).toBe(-2);
    });
  });

  it('выключенное переопределение дома возвращает правило сети', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5703');

      await saveRatingRule(
        fixture.superadmin,
        { houseId: null, kind: 'admin_action', code: 'help', config: { delta: 4 } },
        { executor: tx },
      );
      await saveRatingRule(
        fixture.superadmin,
        {
          houseId: fixture.houseA,
          kind: 'admin_action',
          code: 'help',
          config: { delta: 9 },
          isActive: false,
        },
        { executor: tx },
      );

      const house = await readRatingRuleTable(fixture.superadmin, fixture.houseA, {
        executor: tx,
      });

      expect(house.rules.actionDeltas.help).toBe(4);
    });
  });

  it('выключенное правило сети убирает порог совсем', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5704');

      await saveRatingRule(
        fixture.superadmin,
        {
          houseId: null,
          kind: 'threshold_down',
          code: 'down:10',
          config: { threshold: 10, actions: ['fine'], fine_amount: 10_000 },
          isActive: false,
        },
        { executor: tx },
      );

      const table = await readRatingRuleTable(fixture.superadmin, null, { executor: tx });

      expect(table.rules.downThresholds.map((rule) => rule.threshold)).toEqual([40, 30, 20]);
    });
  });

  it('копирование переносит переопределения дома и не трогает сеть', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5705');

      await saveRatingRule(
        fixture.superadmin,
        { houseId: fixture.houseA, kind: 'admin_action', code: 'warning', config: { delta: -8 } },
        { executor: tx },
      );

      const copied = await copyRatingRules(
        fixture.superadmin,
        { fromHouseId: fixture.houseA, toHouseId: fixture.houseB },
        { executor: tx },
      );

      const target = await readRatingRuleTable(fixture.superadmin, fixture.houseB, {
        executor: tx,
      });
      const network = await readRatingRuleTable(fixture.superadmin, null, { executor: tx });

      expect(copied).toBe(1);
      expect(target.rules.actionDeltas.warning).toBe(-8);
      expect(network.rules.actionDeltas.warning).toBe(-3);
    });
  });

  it('копировать дом сам в себя нечего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5706');

      await expect(
        copyRatingRules(
          fixture.superadmin,
          { fromHouseId: fixture.houseA, toHouseId: fixture.houseA },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('таблица показывает уровень каждой строки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5707');

      await saveRatingRule(
        fixture.superadmin,
        { houseId: null, kind: 'admin_action', code: 'violation', config: { delta: -2 } },
        { executor: tx },
      );
      await saveRatingRule(
        fixture.superadmin,
        { houseId: fixture.houseA, kind: 'admin_action', code: 'violation', config: { delta: -7 } },
        { executor: tx },
      );

      const table = await readRatingRuleTable(fixture.superadmin, fixture.houseA, {
        executor: tx,
      });
      const rows = table.rows.filter((row) => row.code === 'violation');

      expect(rows.map((row) => row.level).sort()).toEqual(['house', 'network']);
    });
  });
});
