import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import {
  approveAbsence,
  listHouseAbsences,
  listMyAbsences,
  rejectAbsence,
  submitAbsence,
} from './absences';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Отсутствия (docs/03-BUSINESS-RULES.md §9, docs/04-MODULES/05-presence.md).
 *
 * Жилец подаёт три типа, причина обязательна во всех. Долгосрочное — минимум
 * за день. Одобряет админ; отклоняет с причиной.
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
const TOMORROW = parseBusinessDate('2026-09-08');
const NEXT_WEEK = parseBusinessDate('2026-09-14');
const NOW = parseInstant('2026-09-07T18:00:00+05:00');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `abs-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `abs-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `abs-b-${suffix}` })
    .returning();

  const houseAId = houseA?.id ?? '';
  const houseBId = houseB?.id ?? '';

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId: houseAId })
    .returning();

  async function resident(tag: string, houseId: string): Promise<string> {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7709${suffix}${tag}`, passwordHash: 'x', role: 'resident' })
      .returning();

    await tx.insert(schema.residencies).values({
      orgId,
      userId: user?.id ?? '',
      houseId,
      status: 'active',
      moveInDate: '2026-09-01',
    });

    return user?.id ?? '';
  }

  const dweller = await resident('1', houseAId);
  const stranger = await resident('2', houseBId);

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseA: houseAId,
    houseB: houseBId,
    dwellerId: dweller,
    strangerId: stranger,
    admin: actor(context('admin', adminUser?.id ?? '', houseAId)),
    adminB: actor(context('admin', adminUser?.id ?? '', houseBId)),
    dweller: actor(context('resident', dweller, null)),
    stranger: actor(context('resident', stranger, null)),
  };
}

describe('подача отсутствия', () => {
  it('краткосрочное фиксируется фактом и одобрения не ждёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5301');

      const absence = await submitAbsence(
        fixture.dweller,
        {
          type: 'short',
          startDate: TODAY,
          startAt: parseInstant('2026-09-07T23:40:00+05:00'),
          reason: 'Задержусь на работе',
        },
        { executor: tx, today: TODAY, instant: NOW },
      );

      expect(absence.type).toBe('short');
      expect(absence.status).toBe('approved');
      expect(absence.reviewedAt).not.toBeNull();
    });
  });

  it('админ без проживания подаёт не за жильца, а никак', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5311');

      /*
       * Дом жильца берётся из проживания, и до фильтра по пользователю
       * первым попадалось проживание любого жильца дома: заявка админа
       * записалась бы на него.
       */
      await expect(
        submitAbsence(
          fixture.admin,
          { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Уезжаю' },
          { executor: tx, today: TODAY, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('долгосрочное и болезнь ждут решения админа', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5302');

      const long = await submitAbsence(
        fixture.dweller,
        { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Уезжаю домой' },
        { executor: tx, today: TODAY, instant: NOW },
      );
      const sick = await submitAbsence(
        fixture.dweller,
        { type: 'sick', startDate: TODAY, endDate: TOMORROW, reason: 'Простуда' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      expect(long.status).toBe('pending');
      expect(sick.status).toBe('pending');
    });
  });

  it('долгосрочное не подаётся на сегодня: минимум за день (§9)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5303');

      await expect(
        submitAbsence(
          fixture.dweller,
          { type: 'long', startDate: TODAY, endDate: NEXT_WEEK, reason: 'Сегодня уезжаю' },
          { executor: tx, today: TODAY, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('причина обязательна во всех типах', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5304');

      for (const type of ['short', 'long', 'sick'] as const) {
        await expect(
          submitAbsence(
            fixture.dweller,
            {
              type,
              startDate: type === 'long' ? TOMORROW : TODAY,
              endDate: type === 'short' ? null : NEXT_WEEK,
              reason: '   ',
            },
            { executor: tx, today: TODAY, instant: NOW },
          ),
        ).rejects.toBeInstanceOf(ValidationError);
      }
    });
  });

  it('конец раньше начала не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5305');

      await expect(
        submitAbsence(
          fixture.dweller,
          { type: 'sick', startDate: NEXT_WEEK, endDate: TODAY, reason: 'Ошибка в датах' },
          { executor: tx, today: TODAY, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('жилец без проживания подать отсутствие не может: дома у него нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5306');

      const [orphan] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77095306999',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();

      const actor: UserActor = {
        context: {
          orgId: fixture.orgId,
          userId: orphan?.id ?? '',
          role: 'resident',
          houseId: null,
        },
      };

      await expect(
        submitAbsence(
          actor,
          { type: 'short', startDate: TODAY, reason: 'Некуда возвращаться' },
          { executor: tx, today: TODAY, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('очередь одобрения', () => {
  it('админ видит ожидающие своего дома и не видит чужие', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5310');

      await submitAbsence(
        fixture.dweller,
        { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Отъезд' },
        { executor: tx, today: TODAY, instant: NOW },
      );
      await submitAbsence(
        fixture.stranger,
        { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Отъезд соседа' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      const queue = await listHouseAbsences(
        fixture.admin,
        fixture.houseA,
        { status: 'pending' },
        { executor: tx },
      );

      expect(queue).toHaveLength(1);
      expect(queue[0]?.absence.userId).toBe(fixture.dwellerId);
    });
  });

  it('одобрение записывает автора и время', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5311');

      const absence = await submitAbsence(
        fixture.dweller,
        { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Отъезд' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      const approved = await approveAbsence(fixture.admin, absence.id, {
        executor: tx,
        instant: NOW,
      });

      expect(approved.status).toBe('approved');
      expect(approved.reviewedBy).toBe(fixture.admin.context.userId);
      expect(approved.reviewedAt?.toISOString()).toBe(NOW.toISOString());
    });
  });

  it('отклонение требует причины', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5312');

      const absence = await submitAbsence(
        fixture.dweller,
        { type: 'sick', startDate: TODAY, endDate: TOMORROW, reason: 'Простуда' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      await expect(
        rejectAbsence(fixture.admin, absence.id, '  ', { executor: tx, instant: NOW }),
      ).rejects.toBeInstanceOf(ValidationError);

      const rejected = await rejectAbsence(fixture.admin, absence.id, 'Справки нет', {
        executor: tx,
        instant: NOW,
      });

      expect(rejected.status).toBe('rejected');
      expect(rejected.reviewNote).toBe('Справки нет');
    });
  });

  it('жилец сам себе отсутствие не одобряет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5313');

      const absence = await submitAbsence(
        fixture.dweller,
        { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Отъезд' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      await expect(
        approveAbsence(fixture.dweller, absence.id, { executor: tx, instant: NOW }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('админ чужого дома чужое отсутствие не трогает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5314');

      const absence = await submitAbsence(
        fixture.dweller,
        { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Отъезд' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      await expect(
        approveAbsence(fixture.adminB, absence.id, { executor: tx, instant: NOW }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('решение попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5315');

      const absence = await submitAbsence(
        fixture.dweller,
        { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Отъезд' },
        { executor: tx, today: TODAY, instant: NOW },
      );
      await approveAbsence(fixture.admin, absence.id, { executor: tx, instant: NOW });

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(
          and(eq(schema.auditLog.entityType, 'absence'), eq(schema.auditLog.entityId, absence.id)),
        );

      expect(entries.map((entry) => entry.action)).toContain('absence.approved');
    });
  });
});

describe('свои отсутствия', () => {
  it('жилец видит свой список со статусами', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5320');

      await submitAbsence(
        fixture.dweller,
        { type: 'short', startDate: TODAY, reason: 'Задержусь' },
        { executor: tx, today: TODAY, instant: NOW },
      );
      await submitAbsence(
        fixture.dweller,
        { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Отъезд' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      const mine = await listMyAbsences(fixture.dweller, { executor: tx });

      expect(mine.map((item) => item.type)).toEqual(['short', 'long']);
      expect(mine.map((item) => item.status)).toEqual(['approved', 'pending']);
    });
  });

  it('чужих отсутствий жилец не видит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5321');

      await submitAbsence(
        fixture.dweller,
        { type: 'short', startDate: TODAY, reason: 'Задержусь' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      expect(await listMyAbsences(fixture.stranger, { executor: tx })).toHaveLength(0);
    });
  });

  it('календарь дома показывает имя рядом с отсутствием', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5322');

      await tx
        .insert(schema.residentProfiles)
        .values({ userId: fixture.dwellerId, lastName: 'Отъездов', firstName: 'Тест' });

      await submitAbsence(
        fixture.dweller,
        { type: 'long', startDate: TOMORROW, endDate: NEXT_WEEK, reason: 'Отъезд' },
        { executor: tx, today: TODAY, instant: NOW },
      );

      const calendar = await listHouseAbsences(fixture.admin, fixture.houseA, {}, { executor: tx });

      expect(calendar[0]?.name).toContain('Отъездов');
    });
  });
});
