import { getDb, type Executor } from '@/db/client';
import { listHouses } from '@/db/repositories/houses';
import { claimJobRun, finishJobRun } from '@/db/repositories/job-runs';
import { listAbsences } from '@/db/repositories/rating';
import { listHouseRoster } from '@/db/repositories/residencies';
import { notificationTexts } from '@/lib/i18n/notification-texts';
import { logger } from '@/lib/logger';
import { now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { houseRecipients, networkActors } from './job-actor';
import { notify } from './notifications';

import type { UserActor } from './users';

/**
 * Отбой в 23:00 (docs/04-MODULES/05-presence.md, «Админ»).
 *
 * В 23:05 админ дома получает список тех, кто не подал уведомление
 * о кратковременном отсутствии. Это информация, а не санкция: решение
 * о предупреждении принимает человек, система никого не наказывает сама.
 */
export const CURFEW_CHECK_JOB = 'curfew-check';

export interface CurfewDeps {
  executor?: Executor;
  instant?: Date;
}

export interface CurfewResult {
  date: BusinessDate;
  /** Сколько домов получили список. Дом без «молчунов» письма не получает. */
  houses: number;
  notified: number;
  skipped: boolean;
}

/**
 * Кто в доме не подал кратковременное уведомление на эту дату.
 *
 * Долгосрочное и болезнь сюда не входят: человек в отъезде, и отбой
 * его не касается. Фильтр по дате идёт в памяти — заявок за день
 * единицы, а отдельный индекс по дате ради этого не нужен.
 */
async function silentResidents(
  actor: UserActor,
  houseId: string,
  date: BusinessDate,
  executor: Executor,
): Promise<string[]> {
  const roster = await listHouseRoster(actor.context, houseId, executor);
  const absences = await listAbsences(actor.context, { houseId }, executor);

  const excused = new Set(
    absences
      .filter((absence) => {
        if (absence.type === 'short') {
          return absence.startDate === date;
        }

        if (absence.status !== 'approved') {
          return false;
        }

        // Отъезд и болезнь закрывают отбой на весь свой промежуток.
        return absence.startDate <= date && (absence.endDate ?? absence.startDate) >= date;
      })
      .map((absence) => absence.userId),
  );

  return roster.map((entry) => entry.userId).filter((userId) => !excused.has(userId));
}

export async function checkCurfew(deps: CurfewDeps = {}): Promise<CurfewResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  const date = todayInAlmaty(instant);
  const log = logger.child({ job: CURFEW_CHECK_JOB, date });

  const run = await claimJobRun(CURFEW_CHECK_JOB, date, executor);

  if (run === null) {
    log.info('список за этот день уже отправлен');

    return { date, houses: 0, notified: 0, skipped: true };
  }

  let houses = 0;
  let notified = 0;

  try {
    const actors = await networkActors(CURFEW_CHECK_JOB, executor);

    for (const actor of actors) {
      for (const house of await listHouses(actor.context, {}, executor)) {
        const silent = await silentResidents(actor, house.id, date, executor);

        if (silent.length === 0) {
          continue;
        }

        houses += 1;
        const texts = await notificationTexts('curfew', { date, count: silent.length });

        for (const userId of await houseRecipients(actor, house.id, executor)) {
          await notify(
            actor.context,
            {
              userId,
              type: 'curfew.check',
              title: texts.title,
              body: texts.body,
              payload: { date, houseId: house.id, userIds: silent },
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

  await finishJobRun(run.id, 'done', { houses, notified }, executor);
  log.info({ houses, notified }, 'списки к отбою разосланы');

  return { date, houses, notified, skipped: false };
}
