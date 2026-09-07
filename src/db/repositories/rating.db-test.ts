import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { NotFoundError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import {
  createAbsence,
  createFine,
  createRatingEvent,
  listAbsences,
  listFines,
  listRatingEvents,
  listRatingRules,
  putRatingRule,
  readThresholdStates,
  updateAbsence,
  writeThresholdStates,
} from './rating';

import type { AccessContext } from '../access';
import type { Database, Transaction } from '../client';

/**
 * Отсутствия, рейтинг, штрафы и скидки на настоящем PostgreSQL.
 *
 * Проверяется то, что действует в базе: видимость дома, уникальность правил
 * и событий, состояние порогов. Считает же рейтинг расчётное ядро.
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

const YEAR_START = parseBusinessDate('2026-07-01');
const TODAY = parseBusinessDate('2026-09-07');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rat-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `rat-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `rat-b-${suffix}` })
    .returning();

  const houseAId = houseA?.id ?? '';
  const houseBId = houseB?.id ?? '';

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId: houseAId })
    .returning();
  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7701${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [residentUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  await tx.insert(schema.residencies).values({
    orgId,
    userId: residentUser?.id ?? '',
    houseId: houseAId,
    status: 'active',
    moveInDate: '2026-09-01',
  });

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  return {
    orgId,
    houseA: houseAId,
    houseB: houseBId,
    residentId: residentUser?.id ?? '',
    superadmin: context('superadmin', superUser?.id ?? '', null),
    adminA: context('admin', adminUser?.id ?? '', houseAId),
    adminB: context('admin', adminUser?.id ?? '', houseBId),
    resident: context('resident', residentUser?.id ?? '', null),
  };
}

/** Чужая сеть: жилец существует, но числится в другой организации. */
async function seedOtherOrg(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Другая сеть', slug: `rat-x-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77772${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  return { orgId, userId: user?.id ?? '' };
}

describe('отсутствия', () => {
  it('заводятся жильцом и видны его дому', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5201');

      await createAbsence(
        fixture.resident,
        {
          userId: fixture.residentId,
          houseId: fixture.houseA,
          type: 'long',
          startDate: TODAY,
          endDate: parseBusinessDate('2026-09-20'),
          reason: 'Уезжаю к родителям',
        },
        tx,
      );

      const mine = await listAbsences(fixture.resident, {}, tx);
      const houseView = await listAbsences(fixture.adminA, { houseId: fixture.houseA }, tx);

      expect(mine).toHaveLength(1);
      expect(houseView).toHaveLength(1);
      expect(houseView[0]?.status).toBe('pending');
    });
  });

  it('отсутствия чужого дома админу не видны', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5202');

      await createAbsence(
        fixture.resident,
        {
          userId: fixture.residentId,
          houseId: fixture.houseA,
          type: 'sick',
          startDate: TODAY,
          reason: 'Болею',
        },
        tx,
      );

      expect(await listAbsences(fixture.adminB, { houseId: fixture.houseB }, tx)).toHaveLength(0);
    });
  });

  it('одобрение записывает, кто и когда его дал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5203');

      const absence = await createAbsence(
        fixture.resident,
        {
          userId: fixture.residentId,
          houseId: fixture.houseA,
          type: 'long',
          startDate: TODAY,
          endDate: parseBusinessDate('2026-09-10'),
          reason: 'Поездка',
        },
        tx,
      );

      const approved = await updateAbsence(
        fixture.adminA,
        absence.id,
        {
          status: 'approved',
          reviewedBy: fixture.adminA.userId,
          reviewedAt: new Date('2026-09-07T10:00:00Z'),
        },
        tx,
      );

      expect(approved.status).toBe('approved');
      expect(approved.reviewedBy).toBe(fixture.adminA.userId);
    });
  });

  it('чужое отсутствие жильцу неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5204');

      const absence = await createAbsence(
        fixture.resident,
        {
          userId: fixture.residentId,
          houseId: fixture.houseA,
          type: 'short',
          startDate: TODAY,
          reason: 'Задержусь',
        },
        tx,
      );

      await expect(
        updateAbsence(fixture.adminB, absence.id, { status: 'rejected' }, tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('правила рейтинга', () => {
  it('правило сети и переопределение дома живут рядом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5210');

      await putRatingRule(
        fixture.superadmin,
        { houseId: null, kind: 'score_delta', code: 'score:10', config: { delta: 3 } },
        tx,
      );
      await putRatingRule(
        fixture.superadmin,
        { houseId: fixture.houseA, kind: 'score_delta', code: 'score:10', config: { delta: 5 } },
        tx,
      );

      const all = await listRatingRules(fixture.superadmin, {}, tx);
      const houseOnly = await listRatingRules(fixture.superadmin, { houseId: fixture.houseA }, tx);

      expect(all).toHaveLength(2);
      expect(houseOnly).toHaveLength(1);
      expect(houseOnly[0]?.config).toEqual({ delta: 5 });
    });
  });

  it('повторная запись того же кода правит правило, а не двоит его', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5211');

      await putRatingRule(
        fixture.superadmin,
        { houseId: null, kind: 'admin_action', code: 'violation', config: { delta: -1 } },
        tx,
      );
      await putRatingRule(
        fixture.superadmin,
        { houseId: null, kind: 'admin_action', code: 'violation', config: { delta: -2 } },
        tx,
      );

      const rules = await listRatingRules(fixture.superadmin, {}, tx);

      expect(rules).toHaveLength(1);
      expect(rules[0]?.config).toEqual({ delta: -2 });
    });
  });
});

describe('события рейтинга', () => {
  it('складываются по году рейтинга', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5220');

      await createRatingEvent(
        fixture.adminA,
        { userId: fixture.residentId, type: 'score:10', delta: 3, periodStart: YEAR_START },
        tx,
      );
      await createRatingEvent(
        fixture.adminA,
        { userId: fixture.residentId, type: 'violation', delta: -1, periodStart: YEAR_START },
        tx,
      );
      // Прошлый год в текущее значение не входит.
      await createRatingEvent(
        fixture.adminA,
        {
          userId: fixture.residentId,
          type: 'score:9',
          delta: 2,
          periodStart: parseBusinessDate('2025-07-01'),
        },
        tx,
      );

      const events = await listRatingEvents(
        fixture.adminA,
        { userId: fixture.residentId, periodStart: YEAR_START },
        tx,
      );

      expect(events).toHaveLength(2);
      expect(events.reduce((sum, event) => sum + event.delta, 0)).toBe(2);
    });
  });

  it('одна оценка даёт одно событие: повтор в базу не проходит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5221');
      const refId = '3f1b9a2c-0000-4000-8000-000000000001';

      await createRatingEvent(
        fixture.adminA,
        {
          userId: fixture.residentId,
          type: 'score:8',
          delta: 1,
          refType: 'rotation_assignment',
          refId,
          periodStart: YEAR_START,
        },
        tx,
      );

      const text = await failureText(tx, (inner) =>
        createRatingEvent(
          fixture.adminA,
          {
            userId: fixture.residentId,
            type: 'score:8',
            delta: 1,
            refType: 'rotation_assignment',
            refId,
            periodStart: YEAR_START,
          },
          inner,
        ),
      );

      expect(text).toContain('rating_events_ref_unique');
    });
  });

  it('события чужого дома админу не видны', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5222');

      await createRatingEvent(
        fixture.adminA,
        { userId: fixture.residentId, type: 'help', delta: 2, periodStart: YEAR_START },
        tx,
      );

      expect(
        await listRatingEvents(
          fixture.adminB,
          { userId: fixture.residentId, periodStart: YEAR_START },
          tx,
        ),
      ).toHaveLength(0);
    });
  });
});

describe('состояние порогов', () => {
  it('пишется и читается по жильцу', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5230');

      const rule = await putRatingRule(
        fixture.superadmin,
        {
          houseId: null,
          kind: 'threshold_down',
          code: 'down:40',
          config: { threshold: 40, actions: ['extra_rotation'], fine_amount: 0 },
        },
        tx,
      );

      await writeThresholdStates(
        fixture.adminA,
        fixture.residentId,
        [{ ruleId: rule.id, armed: false, lastTriggeredAt: new Date('2026-09-07T10:00:00Z') }],
        tx,
      );

      const states = await readThresholdStates(fixture.adminA, fixture.residentId, tx);

      expect(states).toHaveLength(1);
      expect(states[0]?.armed).toBe(false);
    });
  });

  it('повторная запись обновляет состояние, а не заводит второе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5231');

      const rule = await putRatingRule(
        fixture.superadmin,
        { houseId: null, kind: 'threshold_down', code: 'down:30', config: { threshold: 30 } },
        tx,
      );

      await writeThresholdStates(
        fixture.adminA,
        fixture.residentId,
        [{ ruleId: rule.id, armed: false }],
        tx,
      );
      await writeThresholdStates(
        fixture.adminA,
        fixture.residentId,
        [{ ruleId: rule.id, armed: true }],
        tx,
      );

      const states = await readThresholdStates(fixture.adminA, fixture.residentId, tx);

      expect(states).toHaveLength(1);
      expect(states[0]?.armed).toBe(true);
    });
  });

  /*
   * Таблица порогов без `org_id`, ключ в ней — «жилец и правило».
   * Сеть проверяется через самого жильца: иначе состояния читались бы
   * по одному лишь идентификатору человека из чужой сети — тот же класс
   * дефекта, что инцидент I6.
   */
  it('пороги жильца чужой сети не читаются и не пишутся', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5232');
      const stranger = await seedOtherOrg(tx, '5232');

      const rule = await putRatingRule(
        fixture.superadmin,
        { houseId: null, kind: 'threshold_down', code: 'down:20', config: { threshold: 20 } },
        tx,
      );

      await tx.insert(schema.ratingThresholdStates).values({
        userId: stranger.userId,
        ruleId: rule.id,
        armed: false,
      });

      expect(await readThresholdStates(fixture.superadmin, stranger.userId, tx)).toEqual([]);
      await expect(
        writeThresholdStates(
          fixture.superadmin,
          stranger.userId,
          [{ ruleId: rule.id, armed: true }],
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('штрафы', () => {
  it('заводятся на жильца дома и видны дому', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5240');

      await createFine(
        fixture.adminA,
        {
          userId: fixture.residentId,
          houseId: fixture.houseA,
          amount: 2_500,
          reason: 'Рейтинг ниже 30',
        },
        tx,
      );

      const mine = await listFines(fixture.adminA, { houseId: fixture.houseA }, tx);

      expect(mine).toHaveLength(1);
      expect(mine[0]?.status).toBe('pending');
      expect(await listFines(fixture.adminB, { houseId: fixture.houseB }, tx)).toHaveLength(0);
    });
  });

  it('штраф в чужом доме не заводится', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5241');

      await expect(
        createFine(
          fixture.adminB,
          {
            userId: fixture.residentId,
            houseId: fixture.houseA,
            amount: 5_000,
            reason: 'Чужой дом',
          },
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
