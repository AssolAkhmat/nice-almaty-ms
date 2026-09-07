import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { addDays, parseBusinessDate, parseInstant, type BusinessDate } from '@/lib/time';

import { readHouseDashboard, readNetworkDashboard, readResidentDashboard } from './dashboard';
import { createInvoice } from './invoices';
import { saveRow } from './rotation-rows';
import { generateSchedule } from './rotation-schedule';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Дэшборд жильца (docs/04-MODULES/09-dashboards.md).
 *
 * Шесть блоков собираются одним запросом к сервису: ближайшая уборка,
 * счёт, депозит, рейтинг и то, что требует внимания. Экран проверяет
 * приёмка, здесь — состав данных.
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

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `dsh-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `dsh-a-${suffix}` })
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

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [dwellerUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: dwellerUser?.id ?? '',
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

  const context = (role: AccessContext['role'], userId: string): AccessContext => ({
    orgId,
    userId,
    role,
    houseId: null,
  });

  const network: UserActor = {
    context: context('superadmin', superUser?.id ?? ''),
    requestId: `req-${suffix}`,
  };

  return {
    orgId,
    houseId,
    bedId: bed?.id ?? '',
    yardId: yard?.id ?? '',
    checklistId: checklist?.id ?? '',
    residencyId: residency?.id ?? '',
    dwellerId: dwellerUser?.id ?? '',
    network,
    dweller: {
      context: context('resident', dwellerUser?.id ?? ''),
      requestId: `req-${suffix}`,
    } satisfies UserActor,
  };
}

async function withRotationOn(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
  date: BusinessDate,
): Promise<void> {
  await saveRow(
    fixture.network,
    {
      houseId: fixture.houseId,
      name: 'Двор',
      type: 'common',
      weekday: 1,
      startDate: date,
      slots: [{ bedId: fixture.bedId }],
      zones: [{ areaId: fixture.yardId, checklistId: fixture.checklistId }],
    },
    { executor: tx },
  );

  await generateSchedule(fixture.network, fixture.houseId, date, { executor: tx, today: date });
}

describe('дэшборд жильца', () => {
  it('показывает ближайшую уборку с кнопкой подтверждения в её день', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6701');
      await withRotationOn(tx, fixture, MONDAY);

      const view = await readResidentDashboard(fixture.dweller, { executor: tx, today: MONDAY });

      expect(view?.nextCleaning?.date).toBe(MONDAY);
      expect(view?.nextCleaning?.areaName).toBe('Двор');
      expect(view?.nextCleaning?.canConfirm).toBe(true);
    });
  });

  it('заранее уборка видна, но подтверждать её ещё нечего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6702');
      await withRotationOn(tx, fixture, MONDAY);

      const view = await readResidentDashboard(fixture.dweller, {
        executor: tx,
        today: addDays(MONDAY, -3),
      });

      expect(view?.nextCleaning?.date).toBe(MONDAY);
      expect(view?.nextCleaning?.canConfirm).toBe(false);
    });
  });

  it('вчерашняя неподтверждённая важнее будущих: её ещё можно закрыть', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6703');
      await withRotationOn(tx, fixture, MONDAY);

      const view = await readResidentDashboard(fixture.dweller, {
        executor: tx,
        today: addDays(MONDAY, 1),
      });

      expect(view?.nextCleaning?.date).toBe(MONDAY);
      expect(view?.nextCleaning?.canConfirm).toBe(true);
    });
  });

  it('счёт к оплате и депозит на месте', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6704');

      await createInvoice(
        fixture.network,
        {
          residencyId: fixture.residencyId,
          type: 'monthly',
          periodMonth: parseBusinessDate('2026-09-01'),
          dueDate: parseBusinessDate('2026-09-10'),
          lines: [{ kind: 'rent', title: 'Проживание', amount: 100_000 }],
        },
        { executor: tx, today: MONDAY },
      );

      await tx.insert(schema.depositTransactions).values({
        orgId: fixture.orgId,
        residencyId: fixture.residencyId,
        type: 'charge',
        amount: 100_000,
        note: 'Депозит внесён',
      });

      const view = await readResidentDashboard(fixture.dweller, { executor: tx, today: MONDAY });

      expect(view?.invoice?.remaining).toBe(100_000);
      expect(view?.invoice?.dueDate).toBe('2026-09-10');
      expect(view?.deposit.balance).toBe(100_000);
      expect(view?.deposit.transactions).toHaveLength(1);
    });
  });

  it('отклонённый документ попадает в «Требуется внимание»', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6705');

      const [type] = await tx
        .insert(schema.documentTypes)
        .values({
          orgId: fixture.orgId,
          code: 'flg',
          nameI18n: { ru: 'Флюорография', kk: 'Флюорография', en: 'Chest X-ray' },
          validityMonths: 12,
        })
        .returning();

      const [file] = await tx
        .insert(schema.files)
        .values({
          orgId: fixture.orgId,
          provider: 'local',
          path: `documents/${fixture.residencyId}.pdf`,
          mime: 'application/pdf',
          sizeBytes: 1024,
          originalName: 'flg.pdf',
          status: 'ready',
          uploadedBy: fixture.dwellerId,
        })
        .returning();

      await tx.insert(schema.documents).values({
        orgId: fixture.orgId,
        userId: fixture.dwellerId,
        residencyId: fixture.residencyId,
        documentTypeId: type?.id ?? '',
        fileId: file?.id ?? '',
        validFrom: '2026-01-01',
        validUntil: '2026-12-31',
        status: 'rejected',
        rejectReason: 'Нечитаемый скан',
      });

      const view = await readResidentDashboard(fixture.dweller, { executor: tx, today: MONDAY });

      const rejected = view?.attention.documents.find((item) => item.reason === 'rejected');
      expect(rejected).toBeDefined();
      expect(rejected?.title).toMatchObject({ ru: 'Флюорография' });
    });
  });

  it('дэшборд дома показывает уборки дня и требующее решения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6707');
      await withRotationOn(tx, fixture, MONDAY);

      const view = await readHouseDashboard(fixture.network, fixture.houseId, {
        executor: tx,
        today: MONDAY,
      });

      expect(view.cleanings).toHaveLength(1);
      expect(view.cleanings[0]?.areaName).toBe('Двор');
      expect(view.cleanings[0]?.workers[0]?.state).toBe('assigned');
      // Сегодняшняя ещё не просрочена: решать нечего.
      expect(view.decisions).toEqual([]);
    });
  });

  it('вчерашняя неподтверждённая попадает в «Требует решения»', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6708');
      await withRotationOn(tx, fixture, MONDAY);

      const view = await readHouseDashboard(fixture.network, fixture.houseId, {
        executor: tx,
        today: addDays(MONDAY, 1),
      });

      expect(view.decisions).toHaveLength(1);
      expect(view.decisions[0]?.kind).toBe('unconfirmed');
      expect(view.decisions[0]?.date).toBe(MONDAY);
    });
  });

  it('деньги месяца: выставлено, оплачено, долг и должники', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6709');

      await createInvoice(
        fixture.network,
        {
          residencyId: fixture.residencyId,
          type: 'monthly',
          periodMonth: parseBusinessDate('2026-09-01'),
          dueDate: parseBusinessDate('2026-09-10'),
          lines: [{ kind: 'rent', title: 'Проживание', amount: 100_000 }],
        },
        { executor: tx, today: MONDAY },
      );

      const view = await readHouseDashboard(fixture.network, fixture.houseId, {
        executor: tx,
        today: MONDAY,
      });

      expect(view.money.issued).toBe(100_000);
      expect(view.money.paid).toBe(0);
      expect(view.money.debt).toBe(100_000);
      expect(view.money.debtors).toHaveLength(1);
    });
  });

  it('коммуналка без периода названа незаведённой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6710');

      const view = await readHouseDashboard(fixture.network, fixture.houseId, {
        executor: tx,
        today: MONDAY,
      });

      expect(view.utilities.status).toBe('missing');
      expect(view.utilities.month).toBe('2026-09-01');
    });
  });

  it('дэшборд сети сводит дома, занятость и деньги', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6711');

      await createInvoice(
        fixture.network,
        {
          residencyId: fixture.residencyId,
          type: 'monthly',
          periodMonth: parseBusinessDate('2026-09-01'),
          dueDate: parseBusinessDate('2026-09-10'),
          lines: [{ kind: 'rent', title: 'Проживание', amount: 100_000 }],
        },
        { executor: tx, today: MONDAY },
      );

      const view = await readNetworkDashboard(fixture.network, { executor: tx, today: MONDAY });
      const house = view.houses.find((row) => row.houseId === fixture.houseId);

      expect(house?.beds).toEqual({ taken: 1, total: 1 });
      expect(house?.issued).toBe(100_000);
      expect(house?.debt).toBe(100_000);
    });
  });

  it('расторжение попадает в обратный отсчёт возврата', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6712');

      await tx
        .update(schema.residencies)
        .set({
          status: 'terminating',
          terminationRequestedAt: parseInstant('2026-08-15T12:00:00+05:00'),
          moveOutDate: '2026-08-15',
        })
        .where(eq(schema.residencies.id, fixture.residencyId));

      const view = await readNetworkDashboard(fixture.network, { executor: tx, today: MONDAY });
      const refund = view.refunds.find((row) => row.residencyId === fixture.residencyId);

      expect(refund?.deadline).toBe('2026-09-14');
      expect(refund?.daysLeft).toBe(7);
    });
  });

  it('без проживания дэшборда нет: показывать нечего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6706');

      const [stranger] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77098880001',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();

      const view = await readResidentDashboard(
        {
          context: {
            orgId: fixture.orgId,
            userId: stranger?.id ?? '',
            role: 'resident',
            houseId: null,
          },
          requestId: 'req-6706',
        },
        { executor: tx, today: MONDAY },
      );

      expect(view).toBeNull();
    });
  });
});
