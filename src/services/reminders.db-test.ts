import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedRow } from '@/db/testing/rotation-row';
import { testDatabaseUrl } from '@/db/testing/database-url';
import {
  addDays,
  parseBusinessDate,
  parseInstant,
  startOfDayUtc,
  toAlmatyParts,
  type BusinessDate,
} from '@/lib/time';

import { NIGHT_ABSENCES_JOB, sendNightAbsences } from './night-absences';
import { watchDepositRefunds, watchDocumentExpiry } from './expiry-reminders';
import { remindSchedule, remindUtilities } from './monthly-reminders';
import { remindRotations } from './rotation-reminders';
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

/*
 * Понедельник далёкого марта, а не «сегодня»: задания идемпотентны по дню,
 * и день настоящего прогона приёмка уже могла занять — тогда тест увидел бы
 * «уже разослано» вместо рассылки. Дата в будущем принадлежит только тесту.
 */
const MONDAY = parseBusinessDate('2027-03-08');
const MORNING = parseInstant('2027-03-08T09:00:00+05:00');
const EVENING = parseInstant('2027-03-08T19:00:00+05:00');

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
      moveInDate: '2027-03-01',
    })
    .returning();

  await tx.insert(schema.bedAssignments).values({
    residencyId: residency?.id ?? '',
    bedId: bed?.id ?? '',
    houseId: houseId,
    price: 100_000,
    period: '[2027-03-01,)',
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
  await seedRow(
    fixture.network,
    {
      houseId: fixture.houseId,
      name: 'Двор',
      type: 'common',
      weekday: weekdayOf(date),
      startDate: date,
      bedIds: [fixture.bedId],
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

      expect(result.periodKey).toBe('2027-03-08:morning');

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

      expect(result.periodKey).toBe('2027-03-08:evening');

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

describe('ночная сводка заявленных отсутствий', () => {
  /*
   * Требование «список тех, кто не подавал уведомление» признано ошибочным
   * (решение владельца, 30 сентября 2026): события возврата в системе нет,
   * и сказать «не вернулся» ей нечем. Сводка сообщает обратное — кто заявился.
   *
   * Каждая проверка здесь падала бы на прежнем задании: оно рассылало ровно
   * противоположную выборку и уходило даже тогда, когда заявлений не было
   * вовсе.
   */
  const NIGHT = parseBusinessDate('2027-03-15');
  const AT_2305 = parseInstant('2027-03-15T23:05:00+05:00');

  async function declare(
    tx: Transaction,
    fixture: Awaited<ReturnType<typeof seed>>,
    input: {
      userId: string;
      type: 'short' | 'long' | 'sick';
      start: string;
      end?: string | null;
      status?: 'pending' | 'approved';
      reason?: string;
    },
  ) {
    await tx.insert(schema.absences).values({
      orgId: fixture.orgId,
      userId: input.userId,
      houseId: fixture.houseId,
      type: input.type,
      startDate: input.start,
      endDate: input.end ?? null,
      reason: input.reason ?? 'к родителям',
      status: input.status ?? 'approved',
    });
  }

  it('без заявлений сводка не уходит вовсе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6605');

      const result = await sendNightAbsences({ executor: tx, instant: AT_2305 });

      expect(result.houses).toBe(0);
      expect(result.notified).toBe(0);
      expect(await notificationsOf(tx, fixture.adminId ?? '')).toEqual([]);
      expect(await notificationsOf(tx, fixture.superId)).toEqual([]);
    });
  });

  /*
   * Суть исправления: в сводке только те, кто заявился. Прежнее задание
   * называло ровно обратных — тех, кто молчал, потому что был дома.
   */
  it('жилец, который ничего не заявлял, в сводке не появляется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6606');

      const [silentUser] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77190006606',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();

      await tx.insert(schema.residencies).values({
        orgId: fixture.orgId,
        userId: silentUser?.id ?? '',
        houseId: fixture.houseId,
        status: 'active',
        moveInDate: '2027-03-01',
      });

      await tx
        .insert(schema.residentProfiles)
        .values({ userId: silentUser?.id ?? '', lastName: 'Домов', firstName: 'Дома' });
      await tx
        .insert(schema.residentProfiles)
        .values({ userId: fixture.dwellerId, lastName: 'Уехалов', firstName: 'Уехал' });

      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'short',
        start: NIGHT,
        reason: 'ночная смена',
      });

      await sendNightAbsences({ executor: tx, instant: AT_2305 });

      const body =
        (
          (await notificationsOf(tx, fixture.adminId ?? ''))[0]?.bodyI18n as
            Record<string, string> | undefined
        )?.ru ?? '';

      expect(body).toContain('Уехалов');
      expect(body).not.toContain('Домов');
    });
  });

  it('заявленное на эту ночь отсутствие попадает в сводку с датой и причиной', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6607');

      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'long',
        start: '2027-03-14',
        end: '2027-03-20',
        reason: 'соревнования',
      });

      const result = await sendNightAbsences({ executor: tx, instant: AT_2305 });

      expect(result.houses).toBe(1);

      const [notification] = await notificationsOf(tx, fixture.adminId ?? '');

      expect(notification?.type).toBe('presence.night');

      const body = (notification?.bodyI18n as Record<string, string>).ru;

      expect(body).toContain('2027-03-20');
      expect(body).toContain('соревнования');

      /* Выводов сводка не делает: слов о невозвращении в ней нет. */
      expect(body).not.toContain('не вернул');
      expect(body).not.toContain('наруш');
    });
  });

  it('неодобренное заявление в сводку не идёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6608');

      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'long',
        start: '2027-03-14',
        end: '2027-03-20',
        status: 'pending',
      });

      expect((await sendNightAbsences({ executor: tx, instant: AT_2305 })).notified).toBe(0);
    });
  });

  it('краткосрочное уведомление годится фактом подачи, без одобрения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6610');

      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'short',
        start: NIGHT,
        status: 'pending',
        reason: 'ночная смена',
      });

      const result = await sendNightAbsences({ executor: tx, instant: AT_2305 });

      expect(result.houses).toBe(1);
      expect(
        ((await notificationsOf(tx, fixture.adminId ?? ''))[0]?.bodyI18n as Record<string, string>)
          .ru,
      ).toContain('ночная смена');
    });
  });

  it('истёкший срок без нового уведомления попадает во вторую секцию', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6611');

      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'long',
        start: '2027-03-05',
        end: '2027-03-10',
        reason: 'домой',
      });

      const result = await sendNightAbsences({ executor: tx, instant: AT_2305 });

      expect(result.houses).toBe(1);

      const body = (
        (await notificationsOf(tx, fixture.adminId ?? ''))[0]?.bodyI18n as
          Record<string, string> | undefined
      )?.ru;

      expect(body).toContain('2027-03-10');
      expect(body).toContain('домой');
    });
  });

  it('новое заявление на эту ночь снимает человека из истёкших', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6612');

      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'long',
        start: '2027-03-05',
        end: '2027-03-10',
        reason: 'домой',
      });
      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'long',
        start: '2027-03-12',
        end: '2027-03-20',
        reason: 'продлил',
      });

      await sendNightAbsences({ executor: tx, instant: AT_2305 });

      const body = (
        (await notificationsOf(tx, fixture.adminId ?? ''))[0]?.bodyI18n as
          Record<string, string> | undefined
      )?.ru;

      /* Он в первой секции, а не в истёкших: строка про истёкший срок одна. */
      expect(body).toContain('продлил');
      expect(body).not.toContain('домой');
    });
  });

  it('давно истёкшее заявление в сводке не висит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6613');

      /* Полтора месяца назад: за пределами окна в две недели. */
      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'long',
        start: '2027-01-20',
        end: '2027-01-31',
      });

      expect((await sendNightAbsences({ executor: tx, instant: AT_2305 })).notified).toBe(0);
    });
  });

  it('несовершеннолетний помечен и идёт первым', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6614');

      const [minorUser] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77190006614',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();

      await tx.insert(schema.residencies).values({
        orgId: fixture.orgId,
        userId: minorUser?.id ?? '',
        houseId: fixture.houseId,
        status: 'active',
        moveInDate: '2027-03-01',
      });

      /* Профили: у несовершеннолетнего — «Юнов», у взрослого — «Адамов». */
      await tx.insert(schema.residentProfiles).values({
        userId: minorUser?.id ?? '',
        lastName: 'Юнов',
        firstName: 'Юн',
        birthDate: '2010-06-01',
      });
      await tx.insert(schema.residentProfiles).values({
        userId: fixture.dwellerId,
        lastName: 'Адамов',
        firstName: 'Адам',
        birthDate: '1999-06-01',
      });

      await declare(tx, fixture, {
        userId: minorUser?.id ?? '',
        type: 'short',
        start: NIGHT,
        reason: 'у родственников',
      });
      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'short',
        start: NIGHT,
        reason: 'ночная смена',
      });

      await sendNightAbsences({ executor: tx, instant: AT_2305 });

      const body =
        (
          (await notificationsOf(tx, fixture.adminId ?? ''))[0]?.bodyI18n as
            Record<string, string> | undefined
        )?.ru ?? '';

      expect(body).toContain('несовершеннолетний');

      /*
       * Первым идёт несовершеннолетний, хотя по алфавиту он второй:
       * у него ночная норма строже (Приложение №1, подраздел 2.2).
       */
      expect(body.indexOf('Юнов')).toBeLessThan(body.indexOf('Адамов'));
    });
  });

  it('повторный вызов за ту же ночь второй сводки не рассылает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6615');

      await declare(tx, fixture, {
        userId: fixture.dwellerId,
        type: 'short',
        start: NIGHT,
      });

      await sendNightAbsences({ executor: tx, instant: AT_2305 });
      const again = await sendNightAbsences({ executor: tx, instant: AT_2305 });

      expect(again.skipped).toBe(true);
      expect(await notificationsOf(tx, fixture.adminId ?? '')).toHaveLength(1);

      const runs = await tx
        .select()
        .from(schema.jobRuns)
        .where(eq(schema.jobRuns.job, NIGHT_ABSENCES_JOB));

      expect(runs).toHaveLength(1);
    });
  });
});

describe('напоминания 25 числа', () => {
  const ON_25TH = parseInstant('2027-03-25T10:00:00+05:00');

  it('коммуналка за месяц напоминается тому, кто ведёт дом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6609');

      const result = await remindUtilities({ executor: tx, instant: ON_25TH });

      expect(result.month).toBe('2027-03-01');

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
        month: '2027-03-01',
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

      expect(result.month).toBe('2027-04-01');

      const [notification] = await notificationsOf(tx, fixture.adminId ?? '');
      expect(notification?.type).toBe('schedule.remind');
    });
  });

  it('составленное расписание напоминания не требует', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6613');
      await withRotation(tx, fixture, parseBusinessDate('2027-04-05'));

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
          terminationRequestedAt: parseInstant('2027-02-13T12:00:00+05:00'),
          moveOutDate: '2027-02-13',
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
          terminationRequestedAt: parseInstant('2027-02-05T12:00:00+05:00'),
          moveOutDate: '2027-02-05',
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
          terminationRequestedAt: parseInstant('2027-02-24T12:00:00+05:00'),
          moveOutDate: '2027-02-24',
        })
        .where(eq(schema.residencies.id, fixture.residencyId));

      await watchDepositRefunds({ executor: tx, instant: MORNING });

      expect(await notificationsOf(tx, fixture.superId)).toEqual([]);
    });
  });
});
