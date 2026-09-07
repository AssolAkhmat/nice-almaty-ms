import { getDb, type Executor } from '@/db/client';
import { listHouses } from '@/db/repositories/houses';
import { claimJobRun, finishJobRun } from '@/db/repositories/job-runs';
import { listOccurrences } from '@/db/repositories/rotations';
import { listUtilityPeriods } from '@/db/repositories/utilities';
import { notificationTexts } from '@/lib/i18n/notification-texts';
import { logger } from '@/lib/logger';
import {
  addMonths,
  endOfMonth,
  now,
  startOfMonth,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import { houseRecipients, networkActors } from './job-actor';
import { notify } from './notifications';

/**
 * Напоминания 25 числа (docs/01-ARCHITECTURE.md, «Планировщик»).
 *
 * Коммуналка за текущий месяц должна быть закрыта до генерации счетов
 * первого числа (§3), а расписание ротаций на следующий месяц — составлено
 * до его начала. Оба напоминания идут тому, кто ведёт дом: админу,
 * а если админа нет — суперадмину сети (P6-17).
 */
export const UTILITIES_REMIND_JOB = 'utilities-remind';
export const SCHEDULE_REMIND_JOB = 'schedule-remind';

/** День, когда напоминания уходят: до конца месяца остаётся неделя. */
const REMIND_DAY = 25;

export interface MonthlyReminderDeps {
  executor?: Executor;
  instant?: Date;
}

export interface MonthlyReminderResult {
  /** Месяц, о котором напоминали. */
  month: BusinessDate;
  notified: number;
  /** Прогон уже был или сегодня не 25 число. */
  skipped: boolean;
}

function monthLabel(month: BusinessDate): string {
  return month.slice(0, 7);
}

/**
 * Напоминание заполнить коммуналку за текущий месяц.
 *
 * Дом, где период уже закрыт, письма не получает: напоминать не о чем.
 * Открытый черновик — получает: суммы в нём могли и не появиться.
 */
export async function remindUtilities(
  deps: MonthlyReminderDeps = {},
): Promise<MonthlyReminderResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  const today = todayInAlmaty(instant);
  const month = startOfMonth(today);
  const log = logger.child({ job: UTILITIES_REMIND_JOB, month });

  if (Number(today.slice(8, 10)) !== REMIND_DAY) {
    log.info('сегодня не 25 число');

    return { month, notified: 0, skipped: true };
  }

  const run = await claimJobRun(UTILITIES_REMIND_JOB, month, executor);

  if (run === null) {
    log.info('за этот месяц уже напоминали');

    return { month, notified: 0, skipped: true };
  }

  let notified = 0;

  try {
    const texts = await notificationTexts('utilities', { month: monthLabel(month) });

    for (const actor of await networkActors(UTILITIES_REMIND_JOB, executor)) {
      for (const house of await listHouses(actor.context, {}, executor)) {
        const periods = await listUtilityPeriods(actor.context, { houseId: house.id }, executor);
        const closed = periods.some(
          (period) => period.month === month && period.status === 'closed',
        );

        if (closed) {
          continue;
        }

        for (const userId of await houseRecipients(actor, house.id, executor)) {
          await notify(
            actor.context,
            {
              userId,
              type: 'utilities.remind',
              title: texts.title,
              body: texts.body,
              payload: { month, houseId: house.id },
            },
            executor,
          );
          notified += 1;
        }
      }
    }
  } catch (error) {
    await finishJobRun(run.id, 'failed', { error: String(error) }, executor);
    throw error;
  }

  await finishJobRun(run.id, 'done', { notified }, executor);
  log.info({ notified }, 'напоминания о коммуналке разосланы');

  return { month, notified, skipped: false };
}

/**
 * Напоминание составить расписание ротаций на следующий месяц.
 *
 * Дом, где занятия на следующий месяц уже есть, письма не получает:
 * расписание составлено, напоминать не о чем.
 */
export async function remindSchedule(
  deps: MonthlyReminderDeps = {},
): Promise<MonthlyReminderResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  const today = todayInAlmaty(instant);
  const month = startOfMonth(addMonths(today, 1));
  const log = logger.child({ job: SCHEDULE_REMIND_JOB, month });

  if (Number(today.slice(8, 10)) !== REMIND_DAY) {
    log.info('сегодня не 25 число');

    return { month, notified: 0, skipped: true };
  }

  const run = await claimJobRun(SCHEDULE_REMIND_JOB, month, executor);

  if (run === null) {
    log.info('на этот месяц уже напоминали');

    return { month, notified: 0, skipped: true };
  }

  let notified = 0;

  try {
    const texts = await notificationTexts('schedule', { month: monthLabel(month) });
    const range = { from: month, to: endOfMonth(month) };

    for (const actor of await networkActors(SCHEDULE_REMIND_JOB, executor)) {
      for (const house of await listHouses(actor.context, {}, executor)) {
        const occurrences = await listOccurrences(actor.context, house.id, range, executor);

        if (occurrences.length > 0) {
          continue;
        }

        for (const userId of await houseRecipients(actor, house.id, executor)) {
          await notify(
            actor.context,
            {
              userId,
              type: 'schedule.remind',
              title: texts.title,
              body: texts.body,
              payload: { month, houseId: house.id },
            },
            executor,
          );
          notified += 1;
        }
      }
    }
  } catch (error) {
    await finishJobRun(run.id, 'failed', { error: String(error) }, executor);
    throw error;
  }

  await finishJobRun(run.id, 'done', { notified }, executor);
  log.info({ notified }, 'напоминания о расписании разосланы');

  return { month, notified, skipped: false };
}
