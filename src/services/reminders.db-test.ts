import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import {
  addDays,
  parseBusinessDate,
  parseInstant,
  startOfDayUtc,
  toAlmatyParts,
  type BusinessDate,
} from '@/lib/time';

import { checkCurfew } from './curfew';
import { watchDepositRefunds, watchDocumentExpiry } from './expiry-reminders';
import { remindSchedule, remindUtilities } from './monthly-reminders';
import { remindRotations } from './rotation-reminders';
import { saveRow } from './rotation-rows';
import { generateSchedule } from './rotation-schedule';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Задания планировщика фазы 6 (docs/01-ARCHITECTURE.md, «Планировщик»).
 *
 * Каждое идемпотентно через `job_runs`: повторный вызов за тот же период
 * ничего не рассылает второй раз. Ни одно из них никого не наказывает —
 * это напоминания, а решения принимает человек.
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

/** Понедельник: в этот день недели стоит ряд ротаций в фикстуре. */
const MONDAY = parseBusinessDate('2026-09-07');
const MORNING = parseInstant('2026-09-07T09:00:00+05:00');
const EVENING = parseInstant('2026-09-07T19:00:00+05:00');

async function seed(tx: Transaction, suffix: string, options: { withAdmin?: boolean } = {}) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rem-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `rem-a-${suffix}` })
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

  const adminUser =
    options.withAdmin === false
      ? undefined
      : (
          await tx
            .insert(schema.users)
            .values({
              orgId,
              phone: `+7707${suffix}`,
              passwordHash: 'x',
              role: 'admin',
              houseId,
            })
            .returning()
        )[0];

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

  const context: AccessContext = {
    orgId,
    userId: superUser?.id ?? '',
    role: 'superadmin',
    houseId: null,
  };

  return {
    orgId,
    houseId,
    bedId: bed?.id ?? '',
    yardId: yard?.id ?? '',
    checklistId: checklist?.id ?? '',
    residencyId: residency?.id ?? '',
    dwellerId: dwellerUser?.id ?? '',
    adminId: adminUser?.id ?? null,
    superId: superUser?.id ?? '',
    network: { context, requestId: `req-${suffix}` } satisfies UserActor,
  };
}

/** День недели ряда берётся из даты: ряд ставится ровно на неё. */
function weekdayOf(date: BusinessDate): number {
  const weekday = toAlmatyParts(startOfDayUtc(date)).weekday;

  return weekday === 0 ? 7 : weekday;
}

/** Ряд и расписание на неделю: без них уборки не существует. */
async function withRotation(
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
      weekday: weekdayOf(date),
      startDate: date,
      slots: [{ bedId: fixture.bedId }],
      zones: [{ areaId: fixture.yardId, checklistId: fixture.checklistId }],
    },
    { executor: tx },
  );

  await generateSchedule(fixture.network, fixture.houseId, date, { executor: tx, today: date });
}

async function notificationsOf(tx: Transaction, userId: string) {
  return tx.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
}

describe('напоминания о ротациях', () => {
  it('утром жилец узнаёт о сегодняшней уборке', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6601');
      await withRotation(tx, fixture, MONDAY);

      const result = await remindRotations({ executor: tx, instant: MORNING });

      expect(result.periodKey).toBe('2026-09-07:morning');

      const [notification] = await notificationsOf(tx, fixture.dwellerId);
      expect(notification?.type).toBe('rotation.reminder');
      expect(notification?.titleI18n).toMatchObject({ ru: 'Сегодня ваша уборка' });
    });
  });

  it('вечером — о завтрашней', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6602');
      await withRotation(tx, fixture, addDays(MONDAY, 1));

      const result = await remindRotations({ executor: tx, instant: EVENING });

      expect(result.periodKey).toBe('2026-09-07:evening');

      const [notification] = await notificationsOf(tx, fixture.dwellerId);
      expect(notification?.titleI18n).toMatchObject({ ru: 'Завтра ваша уборка' });
    });
  });

  it('повторный прогон того же слота ничего не рассылает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6603');
      await withRotation(tx, fixture, MONDAY);

      await remindRotations({ executor: tx, instant: MORNING });
      const again = await remindRotations({ executor: tx, instant: MORNING });

      expect(again.skipped).toBe(true);
      expect(await notificationsOf(tx, fixture.dwellerId)).toHaveLength(1);
    });
  });

  it('утренний и вечерний прогоны — разные прогоны', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6604');
      await withRotation(tx, fixture, MONDAY);

      const morning = await remindRotations({ executor: tx, instant: MORNING });
      const evening = await remindRotations({ executor: tx, instant: EVENING });

      expect(morning.skipped).toBe(false);
      expect(evening.skipped).toBe(false);
    });
  });
});

describe('отбой', () => {
  it('жилец без уведомления попадает в список админа', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6605');

      await checkCurfew({ executor: tx, instant: MORNING });

      const [notification] = await notificationsOf(tx, fixture.adminId ?? '');
      expect(notification?.type).toBe('curfew.check');
      expect(notification?.payload).toMatchObject({ userIds: [fixture.dwellerId] });
      // Санкций нет: это список, а не наказание (§9).
      expect(await notificationsOf(tx, fixture.dwellerId)).toEqual([]);
    });
  });

  it('подавший уведомление в список не попадает, и список не уходит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6606');

      await tx.insert(schema.absences).values({
        orgId: fixture.orgId,
        userId: fixture.dwellerId,
        houseId: fixture.houseId,
        type: 'short',
        status: 'approved',
        startDate: '2026-09-07',
        reason: 'Задерживаюсь на работе',
      });

      await checkCurfew({ executor: tx, instant: MORNING });

      expect(await notificationsOf(tx, fixture.adminId ?? '')).toEqual([]);
    });
  });

  it('в доме без админа список уходит суперадмину', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6607', { withAdmin: false });

      await checkCurfew({ executor: tx, instant: MORNING });

      const [notification] = await notificationsOf(tx, fixture.superId);
      expect(notification?.type).toBe('curfew.check');
    });
  });

  it('повторный прогон за день ничего не дублирует', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6608');

      await checkCurfew({ executor: tx, instant: MORNING });
      const again = await checkCurfew({ executor: tx, instant: EVENING });

      expect(again.skipped).toBe(true);
      expect(await notificationsOf(tx, fixture.adminId ?? '')).toHaveLength(1);
    });
  });
});

describe('напоминания 25 числа', () => {
  const ON_25TH = parseInstant('2026-09-25T10:00:00+05:00');

  it('коммуналка за месяц напоминается тому, кто ведёт дом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6609');

      const result = await remindUtilities({ executor: tx, instant: ON_25TH });

      expect(result.month).toBe('2026-09-01');

      const [notification] = await notificationsOf(tx, fixture.adminId ?? '');
      expect(notification?.type).toBe('utilities.remind');
    });
  });

  it('закрытый период напоминания не требует', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6610');

      await tx.insert(schema.utilityPeriods).values({
        orgId: fixture.orgId,
        houseId: fixture.houseId,
        month: '2026-09-01',
        status: 'closed',
      });

      await remindUtilities({ executor: tx, instant: ON_25TH });

      expect(await notificationsOf(tx, fixture.adminId ?? '')).toEqual([]);
    });
  });

  it('в другой день месяца напоминание не уходит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6611');

      const result = await remindUtilities({ executor: tx, instant: MORNING });

      expect(result.skipped).toBe(true);
      expect(await notificationsOf(tx, fixture.adminId ?? '')).toEqual([]);
    });
  });

  it('расписание на следующий месяц напоминается, пока занятий нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6612');

      const result = await remindSchedule({ executor: tx, instant: ON_25TH });

      expect(result.month).toBe('2026-10-01');

      const [notification] = await notificationsOf(tx, fixture.adminId ?? '');
      expect(notification?.type).toBe('schedule.remind');
    });
  });

  it('составленное расписание напоминания не требует', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6613');
      await withRotation(tx, fixture, parseBusinessDate('2026-10-05'));

      await remindSchedule({ executor: tx, instant: ON_25TH });

      expect(await notificationsOf(tx, fixture.adminId ?? '')).toEqual([]);
    });
  });
});

describe('сроки справок', () => {
  async function withDocument(
    tx: Transaction,
    fixture: Awaited<ReturnType<typeof seed>>,
    validUntil: BusinessDate,
  ): Promise<void> {
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
        uploadedBy: fixture.superId,
      })
      .returning();

    await tx.insert(schema.documents).values({
      orgId: fixture.orgId,
      userId: fixture.dwellerId,
      residencyId: fixture.residencyId,
      documentTypeId: type?.id ?? '',
      fileId: file?.id ?? '',
      validFrom: '2026-01-01',
      validUntil,
      status: 'approved',
    });
  }

  it('за тридцать дней предупреждаются жилец и дом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6614');
      await withDocument(tx, fixture, addDays(MONDAY, 30));

      await watchDocumentExpiry({ executor: tx, instant: MORNING });

      const [dweller] = await notificationsOf(tx, fixture.dwellerId);
      expect(dweller?.type).toBe('document.expiring');
      const body = dweller?.bodyI18n as Record<string, string>;
      expect(body.ru).toContain('Флюорография');
      expect(await notificationsOf(tx, fixture.adminId ?? '')).toHaveLength(1);
    });
  });

  it('в день истечения текст другой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6615');
      await withDocument(tx, fixture, MONDAY);

      await watchDocumentExpiry({ executor: tx, instant: MORNING });

      const [dweller] = await notificationsOf(tx, fixture.dwellerId);
      expect(dweller?.titleI18n).toMatchObject({ ru: 'Срок документа истекает сегодня' });
    });
  });

  it('срок, до которого ещё далеко, никого не беспокоит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6616');
      await withDocument(tx, fixture, addDays(MONDAY, 12));

      await watchDocumentExpiry({ executor: tx, instant: MORNING });

      expect(await notificationsOf(tx, fixture.dwellerId)).toEqual([]);
    });
  });
});

describe('возврат депозита', () => {
  it('за семь дней до срока суперадмин получает отсчёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6617');

      await tx
        .update(schema.residencies)
        .set({
          status: 'terminating',
          terminationRequestedAt: parseInstant('2026-08-15T12:00:00+05:00'),
          moveOutDate: '2026-08-15',
        })
        .where(eq(schema.residencies.id, fixture.residencyId));

      await watchDepositRefunds({ executor: tx, instant: MORNING });

      const [notification] = await notificationsOf(tx, fixture.superId);
      expect(notification?.type).toBe('deposit.refund');
      expect(notification?.payload).toMatchObject({ daysLeft: 7 });
    });
  });

  it('просрочка сообщается один раз, в первый день после срока', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6618');

      await tx
        .update(schema.residencies)
        .set({
          status: 'terminating',
          terminationRequestedAt: parseInstant('2026-08-07T12:00:00+05:00'),
          moveOutDate: '2026-08-07',
        })
        .where(eq(schema.residencies.id, fixture.residencyId));

      await watchDepositRefunds({ executor: tx, instant: MORNING });

      const [notification] = await notificationsOf(tx, fixture.superId);
      expect(notification?.titleI18n).toMatchObject({ ru: 'Возврат депозита просрочен' });
    });
  });

  it('середина срока никого не беспокоит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6619');

      await tx
        .update(schema.residencies)
        .set({
          status: 'terminating',
          terminationRequestedAt: parseInstant('2026-08-25T12:00:00+05:00'),
          moveOutDate: '2026-08-25',
        })
        .where(eq(schema.residencies.id, fixture.residencyId));

      await watchDepositRefunds({ executor: tx, instant: MORNING });

      expect(await notificationsOf(tx, fixture.superId)).toEqual([]);
    });
  });
});
