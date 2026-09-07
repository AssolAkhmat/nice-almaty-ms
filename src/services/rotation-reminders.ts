import { getDb, type Executor } from '@/db/client';
import { claimJobRun, finishJobRun } from '@/db/repositories/job-runs';
import { listAssignmentsFor, listOccurrencesOfDate } from '@/db/repositories/rotations';
import { notificationTexts } from '@/lib/i18n/notification-texts';
import { logger } from '@/lib/logger';
import { addDays, now, toAlmatyParts, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { networkActors } from './job-actor';
import { notify } from './notifications';

import type { UserActor } from './users';

/**
 * Напоминания о ротациях (docs/01-ARCHITECTURE.md, «Планировщик»).
 *
 * Утром — про сегодняшнюю уборку и про вчерашнюю, которую ещё не
 * подтвердили: у жильца есть весь следующий день, и напоминание приходит
 * раньше, чем автозакрытие в 23:55 (§7). Вечером — про завтрашнюю, чтобы
 * человек знал заранее, а не в день уборки.
 */
export const ROTATIONS_REMIND_JOB = 'rotations-remind';

export interface ReminderDeps {
  executor?: Executor;
  /** Момент запуска: из него выводится и день, и слот расписания. */
  instant?: Date;
}

export interface ReminderResult {
  /** Ключ прогона: день и слот. Прогонов в сутки два, и они разные. */
  periodKey: string;
  notified: number;
  skipped: boolean;
}

/** До полудня — утренний прогон, после — вечерний. */
export function reminderSlot(instant: Date): 'morning' | 'evening' {
  return toAlmatyParts(instant).hour < 12 ? 'morning' : 'evening';
}

/** Кого касается занятие: исполнители, которые ещё не подтвердили уборку. */
async function pendingWorkers(
  actor: UserActor,
  date: BusinessDate,
  executor: Executor,
): Promise<string[]> {
  const occurrences = await listOccurrencesOfDate(actor.context, date, executor);
  const scheduled = occurrences.filter((occurrence) => occurrence.status === 'scheduled');

  if (scheduled.length === 0) {
    return [];
  }

  const assignments = await listAssignmentsFor(
    scheduled.map((occurrence) => occurrence.id),
    executor,
  );

  const workers = assignments
    .filter((assignment) => assignment.state === 'assigned' && assignment.userId !== null)
    .map((assignment) => assignment.userId ?? '');

  return [...new Set(workers)];
}

export async function remindRotations(deps: ReminderDeps = {}): Promise<ReminderResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  const today = todayInAlmaty(instant);
  const slot = reminderSlot(instant);
  const periodKey = `${today}:${slot}`;
  const log = logger.child({ job: ROTATIONS_REMIND_JOB, periodKey });

  const run = await claimJobRun(ROTATIONS_REMIND_JOB, periodKey, executor);

  if (run === null) {
    log.info('напоминания этого слота уже разосланы');

    return { periodKey, notified: 0, skipped: true };
  }

  let notified = 0;

  try {
    const actors = await networkActors(ROTATIONS_REMIND_JOB, executor);

    for (const actor of actors) {
      if (slot === 'morning') {
        const yesterday = addDays(today, -1);
        const missedTexts = await notificationTexts('rotationMissed', { date: yesterday });

        for (const userId of await pendingWorkers(actor, yesterday, executor)) {
          await notify(
            actor.context,
            {
              userId,
              type: 'rotation.missed',
              title: missedTexts.title,
              body: missedTexts.body,
              payload: { date: yesterday },
            },
            executor,
          );
          notified += 1;
        }

        const todayTexts = await notificationTexts('rotationToday', { date: today });

        for (const userId of await pendingWorkers(actor, today, executor)) {
          await notify(
            actor.context,
            {
              userId,
              type: 'rotation.reminder',
              title: todayTexts.title,
              body: todayTexts.body,
              payload: { date: today },
            },
            executor,
          );
          notified += 1;
        }

        continue;
      }

      const tomorrow = addDays(today, 1);
      const tomorrowTexts = await notificationTexts('rotationTomorrow', { date: tomorrow });

      for (const userId of await pendingWorkers(actor, tomorrow, executor)) {
        await notify(
          actor.context,
          {
            userId,
            type: 'rotation.reminder',
            title: tomorrowTexts.title,
            body: tomorrowTexts.body,
            payload: { date: tomorrow },
          },
          executor,
        );
        notified += 1;
      }
    }
  } catch (error) {
    await finishJobRun(run.id, 'failed', { error: String(error) }, executor);
    throw error;
  }

  await finishJobRun(run.id, 'done', { notified }, executor);
  log.info({ notified }, 'напоминания разосланы');

  return { periodKey, notified, skipped: false };
}
