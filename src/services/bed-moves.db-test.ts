import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { listMonthStaysInHouse } from '@/db/repositories/residencies';

import { assignBedToResidency } from './beds';
import {
  correctAssignment,
  endTemporaryPlacement,
  listTemporaryPlacements,
  moveBedPermanently,
  placeTemporarily,
  previewBedMove,
} from './bed-moves';
import { createDamage } from './damages';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Переселение внутри дома (P1-5, 27 сентября 2026).
 *
 * Проверяется несущее правило: запись назначения места не обновляется никогда.
 * История «кто где жил в какую дату» держит человеко-дни коммуналки, график
 * ротаций и привязку прошлого ущерба к комнате (п. 2.2.3 Договора).
 */
const url = testDatabaseUrl();
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

const MOVE_IN = parseBusinessDate('2026-08-01');
const MOVED = parseBusinessDate('2026-09-15');
const TODAY = parseBusinessDate('2026-09-20');

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

/** Текст отказа вместе с причиной: имя ограничения лежит в `cause`. */
async function failureText(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();

    return '';
  } catch (error) {
    return errorChain(error);
  }
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `move-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const slug = `move-h-${suffix}`;
  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом переселений', slug })
    .returning();
  const houseId = house?.id ?? '';

  await seedChartOfAccounts(tx, orgId, [{ id: houseId, slug, name: 'Дом переселений' }]);

  /* Две комнаты: ущерб привязан к комнате, и переезд обязан это сохранить. */
  const rooms: string[] = [];
  const beds: string[] = [];

  for (const [index, name] of ['Комната 1', 'Комната 2'].entries()) {
    const [area] = await tx
      .insert(schema.areas)
      .values({ houseId, type: 'living', name })
      .returning();
    rooms.push(area?.id ?? '');

    const [bed] = await tx
      .insert(schema.beds)
      .values({
        houseId,
        areaId: area?.id ?? '',
        label: `М${String(index + 1)}`,
        tier: 'lower',
        number: 1,
        defaultPrice: 90_000 + index * 10_000,
      })
      .returning();
    beds.push(bed?.id ?? '');
  }

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7760${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7761${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: user?.id ?? '',
      houseId,
      status: 'active',
      moveInDate: MOVE_IN,
      contractNumber: `2026-${suffix}`,
      depositAmount: 90_000,
    })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    ownHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: ownHouse });

  const superadmin: UserActor = { context: context('superadmin', superUser?.id ?? '', null) };

  await assignBedToResidency(
    superadmin,
    { residencyId: residency?.id ?? '', bedId: beds[0] ?? '', price: 90_000, from: MOVE_IN },
    { executor: tx, today: MOVE_IN },
  );

  return {
    orgId,
    houseId,
    roomOne: rooms[0] ?? '',
    roomTwo: rooms[1] ?? '',
    bedOne: beds[0] ?? '',
    bedTwo: beds[1] ?? '',
    userId: user?.id ?? '',
    residencyId: residency?.id ?? '',
    superadmin,
  };
}

async function assignmentsOf(tx: Transaction, residencyId: string) {
  return tx
    .select({
      bedId: schema.bedAssignments.bedId,
      price: schema.bedAssignments.price,
      period: schema.bedAssignments.period,
    })
    .from(schema.bedAssignments)
    .where(eq(schema.bedAssignments.residencyId, residencyId))
    .orderBy(schema.bedAssignments.period);
}

describe('постоянное переселение внутри дома', () => {
  it('закрывает прежнее назначение датой и открывает новое', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5001');

      const { assignment } = await moveBedPermanently(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          bedId: fixture.bedTwo,
          price: 90_000,
          from: MOVED,
          reason: 'Переезд по просьбе жильца',
        },
        { executor: tx, today: TODAY },
      );

      const rows = await assignmentsOf(tx, fixture.residencyId);

      /*
       * Две записи, а не одна исправленная: прошлое место остаётся прошлым.
       * Ровно на это опираются человеко-дни коммуналки за август и сентябрь.
       */
      expect(rows).toHaveLength(2);
      expect(rows[0]?.bedId).toBe(fixture.bedOne);
      expect(rows[0]?.period).toBe(`[2026-08-01,2026-09-15)`);
      expect(rows[1]?.bedId).toBe(fixture.bedTwo);
      expect(rows[1]?.period).toBe(`[2026-09-15,)`);
      expect(assignment.bedId).toBe(fixture.bedTwo);
    });
  });

  it('новая цена начинает действовать с первого числа следующего месяца', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5002');

      const { priceAppliesFrom } = await moveBedPermanently(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          bedId: fixture.bedTwo,
          price: 100_000,
          from: MOVED,
          reason: 'Место дороже',
          consent: { agreedOn: MOVED },
        },
        { executor: tx, today: TODAY },
      );

      expect(priceAppliesFrom).toBe('2026-10-01');
    });
  });

  it('без отметки о согласии смена цены не проходит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5003');

      await expect(
        moveBedPermanently(
          fixture.superadmin,
          {
            residencyId: fixture.residencyId,
            bedId: fixture.bedTwo,
            price: 100_000,
            from: MOVED,
            reason: 'Место дороже',
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(/consentRequired/);
    });
  });

  it('коммуналка прошлого месяца считается по старому месту', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5005');

      await moveBedPermanently(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          bedId: fixture.bedTwo,
          price: 90_000,
          from: MOVED,
          reason: 'Переезд',
        },
        { executor: tx, today: TODAY },
      );

      /*
       * Человеко-дни коммуналки строятся по занятости мест: за август человек
       * числится на прежнем месте целиком, за сентябрь — половину на прежнем
       * и половину на новом. Это и есть та история, ради которой назначение
       * не перезаписывается.
       */
      const august = await listMonthStaysInHouse(
        fixture.superadmin.context,
        fixture.houseId,
        parseBusinessDate('2026-08-01'),
        tx,
      );
      const september = await listMonthStaysInHouse(
        fixture.superadmin.context,
        fixture.houseId,
        parseBusinessDate('2026-09-01'),
        tx,
      );

      /*
       * Август закрыт одним отрезком прежнего места; сентябрь — двумя:
       * прежнее до 15-го и новое с 15-го. Числа человеко-дней берутся отсюда,
       * и переезд их не переписал.
       */
      expect(august[0]?.periods).toEqual([{ from: '2026-08-01', to: '2026-09-15' }]);
      expect(september[0]?.periods).toEqual([
        { from: '2026-08-01', to: '2026-09-15' },
        { from: '2026-09-15', to: null },
      ]);
    });
  });

  it('ущерб, записанный до переезда, остаётся за прежней комнатой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5004');

      const damage = await createDamage(
        fixture.superadmin,
        {
          houseId: fixture.houseId,
          areaId: fixture.roomOne,
          amount: 30_000,
          splitMode: 'room',
          title: 'Сломан шкаф',
        },
        { executor: tx, today: parseBusinessDate('2026-09-10') },
      );

      await moveBedPermanently(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          bedId: fixture.bedTwo,
          price: 90_000,
          from: MOVED,
          reason: 'Переезд',
        },
        { executor: tx, today: TODAY },
      );

      const [row] = await tx
        .select()
        .from(schema.damages)
        .where(eq(schema.damages.id, damage.damage.id));

      /* Комната ущерба записана в конфигурации разбивки и не меняется. */
      expect((row?.splitConfig as { areaId?: string }).areaId).toBe(fixture.roomOne);

      const shares = await tx
        .select({ userId: schema.damageShares.userId })
        .from(schema.damageShares)
        .where(eq(schema.damageShares.damageId, damage.damage.id));

      /* Доля осталась на том, кто жил в комнате на дату фиксации. */
      expect(shares.map((share) => share.userId)).toEqual([fixture.userId]);
    });
  });
});

describe('временное размещение', () => {
  it('не меняет ни назначение места, ни цену', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5101');
      const before = await assignmentsOf(tx, fixture.residencyId);

      const placement = await placeTemporarily(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          bedId: fixture.bedTwo,
          from: MOVED,
          reason: 'Ремонт в комнате',
        },
        { executor: tx, today: TODAY },
      );

      const after = await assignmentsOf(tx, fixture.residencyId);

      expect(after).toEqual(before);
      expect(placement.bedId).toBe(fixture.bedTwo);
      expect(placement.reason).toBe('Ремонт в комнате');
    });
  });

  it('два размещения на одно место одновременно база не принимает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5102');

      const [other] = await tx
        .insert(schema.users)
        .values({ orgId: fixture.orgId, phone: '+77609999', passwordHash: 'x', role: 'resident' })
        .returning();

      const [second] = await tx
        .insert(schema.residencies)
        .values({
          orgId: fixture.orgId,
          userId: other?.id ?? '',
          houseId: fixture.houseId,
          status: 'active',
          moveInDate: MOVE_IN,
          contractNumber: '2026-5102b',
          depositAmount: 90_000,
        })
        .returning();

      await placeTemporarily(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          bedId: fixture.bedTwo,
          from: MOVED,
          reason: 'Ремонт',
        },
        { executor: tx, today: TODAY },
      );

      const failure = await failureText(() =>
        tx.transaction(async (inner) =>
          placeTemporarily(
            fixture.superadmin,
            {
              residencyId: second?.id ?? '',
              bedId: fixture.bedTwo,
              from: MOVED,
              reason: 'Тоже ремонт',
            },
            { executor: inner, today: TODAY },
          ),
        ),
      );

      expect(failure).toContain('temporary_placements_bed_no_overlap');
    });
  });

  it('закрывается датой и остаётся в истории', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5103');

      const placement = await placeTemporarily(
        fixture.superadmin,
        { residencyId: fixture.residencyId, bedId: fixture.bedTwo, from: MOVED, reason: 'Авария' },
        { executor: tx, today: TODAY },
      );

      await endTemporaryPlacement(fixture.superadmin, placement.id, TODAY, { executor: tx });

      const [row] = await listTemporaryPlacements(fixture.superadmin, fixture.residencyId, {
        executor: tx,
      });

      expect(row?.period).toBe('[2026-09-15,2026-09-20)');
    });
  });

  it('причина обязательна', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5104');

      await expect(
        placeTemporarily(
          fixture.superadmin,
          { residencyId: fixture.residencyId, bedId: fixture.bedTwo, from: MOVED, reason: '  ' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });
});

describe('исправление ошибки ввода места', () => {
  it('аннулирует прежнее назначение и ставит новое той же датой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5201');

      await correctAssignment(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          bedId: fixture.bedTwo,
          price: 100_000,
          reason: 'Место указали неверно при заселении',
        },
        { executor: tx, today: TODAY },
      );

      const rows = await assignmentsOf(tx, fixture.residencyId);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.bedId).toBe(fixture.bedTwo);
      expect(rows[0]?.period).toBe('[2026-08-01,)');
    });
  });

  it('недоступно, когда по проживанию есть проведённое начисление', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5202');

      await tx.insert(schema.invoices).values({
        orgId: fixture.orgId,
        residencyId: fixture.residencyId,
        userId: fixture.userId,
        houseId: fixture.houseId,
        type: 'monthly',
        status: 'issued',
        periodMonth: '2026-09-01',
        dueDate: '2026-09-01',
        total: 90_000,
      });

      await expect(
        correctAssignment(
          fixture.superadmin,
          { residencyId: fixture.residencyId, bedId: fixture.bedTwo, reason: 'Ошибка' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ConflictError);
    });
  });

  it('предпросмотр называет цену, месяц её вступления и наличие начислений', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5203');

      const preview = await previewBedMove(
        fixture.superadmin,
        { residencyId: fixture.residencyId, bedId: fixture.bedTwo },
        { executor: tx, today: TODAY },
      );

      expect(preview.currentPrice).toBe(90_000);
      expect(preview.nextPrice).toBe(100_000);
      expect(preview.priceChanges).toBe(true);
      expect(preview.consentRequired).toBe(true);
      expect(preview.priceAppliesFrom).toBe('2026-10-01');
      expect(preview.hasPostedCharges).toBe(false);
    });
  });

  it('место другого дома этим действием не назначается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5204');

      const [otherHouse] = await tx
        .insert(schema.houses)
        .values({ orgId: fixture.orgId, name: 'Соседний', slug: 'move-other-5204' })
        .returning();

      const [area] = await tx
        .insert(schema.areas)
        .values({ houseId: otherHouse?.id ?? '', type: 'living', name: 'Комната' })
        .returning();

      const [bed] = await tx
        .insert(schema.beds)
        .values({
          houseId: otherHouse?.id ?? '',
          areaId: area?.id ?? '',
          label: 'М1',
          tier: 'lower',
          number: 1,
          defaultPrice: 50_000,
        })
        .returning();

      await expect(
        moveBedPermanently(
          fixture.superadmin,
          { residencyId: fixture.residencyId, bedId: bed?.id ?? '', reason: 'Переезд' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(/otherHouse/);
    });
  });
});

describe('назначения мест', () => {
  it('прошлое назначение не переписывается ни одним из сценариев', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5301');

      await moveBedPermanently(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          bedId: fixture.bedTwo,
          price: 90_000,
          from: MOVED,
          reason: 'Первый переезд',
        },
        { executor: tx, today: TODAY },
      );

      await placeTemporarily(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          bedId: fixture.bedOne,
          from: TODAY,
          reason: 'Ремонт во второй комнате',
        },
        { executor: tx, today: TODAY },
      );

      const rows = await tx
        .select({ id: schema.bedAssignments.id, period: schema.bedAssignments.period })
        .from(schema.bedAssignments)
        .where(
          and(
            eq(schema.bedAssignments.residencyId, fixture.residencyId),
            eq(schema.bedAssignments.bedId, fixture.bedOne),
          ),
        );

      /* Отрезок августа — сентября остался тем же: его закрыли, а не стёрли. */
      expect(rows).toHaveLength(1);
      expect(rows[0]?.period).toBe('[2026-08-01,2026-09-15)');
    });
  });
});
