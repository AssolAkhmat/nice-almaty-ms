import { asc, eq } from 'drizzle-orm';

import { getDb, type Executor } from '@/db/client';
import { claimJobRun, finishJobRun } from '@/db/repositories/job-runs';
import { createRatingEvent } from '@/db/repositories/rating';
import { listResidencies } from '@/db/repositories/residencies';
import { organizations, ratingThresholdStates, users } from '@/db/schema';
import { ratingYearStart } from '@/domain/rating';
import { logger } from '@/lib/logger';
import { businessDateToParts, now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import type { AccessContext } from '@/db/access';
import type { UserActor } from './users';

/**
 * Сброс года рейтинга (docs/03-BUSINESS-RULES.md §5.1, §7).
 *
 * 1 июля рейтинг возвращается к 50, взведённые пороги снимаются, долги
 * по дополнительным ротациям сгорают. Само число ниоткуда не стирается:
 * оно складывается из событий года (P5-4), и новый год начинается пустым.
 * Задание делает то, что из этого не следует само: взводит пороги обратно
 * и оставляет в истории отметку о границе года.
 */
export const RATING_YEAR_RESET_JOB = 'rating-year-reset';

export interface RatingYearDeps {
  executor?: Executor;
  /** Момент запуска: из него выводится дата по календарю Алматы. */
  instant?: Date;
}

export interface RatingYearResult {
  /** Год рейтинга, который открывали: 1 июля. */
  periodStart: BusinessDate;
  /** Сколько жильцов получили отметку о новом годе. */
  residents: number;
  /** Сколько состояний порогов взведено заново. */
  thresholds: number;
  /** Прогон этого года уже был или сегодня не 1 июля. */
  skipped: boolean;
}

/**
 * Задание ходит от имени суперадмина сети: своего пользователя у него нет,
 * а репозитории без контекста доступа не отдают ничего (P3-16).
 */
async function actorForOrg(orgId: string, executor: Executor): Promise<UserActor | null> {
  const [superadmin] = await executor
    .select({ id: users.id })
    .from(users)
    .where(eq(users.orgId, orgId))
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (superadmin === undefined) {
    return null;
  }

  const context: AccessContext = {
    orgId,
    userId: superadmin.id,
    role: 'superadmin',
    houseId: null,
  };

  return { context, requestId: `job:${RATING_YEAR_RESET_JOB}` };
}

export async function resetRatingYear(deps: RatingYearDeps = {}): Promise<RatingYearResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  const today = todayInAlmaty(instant);
  const { month, day } = businessDateToParts(today);
  const periodStart = ratingYearStart(today);
  const log = logger.child({ job: RATING_YEAR_RESET_JOB, periodStart });

  /*
   * Год сбрасывается только 1 июля. Запуск руками в другой день — это
   * почти всегда ошибка: он открыл бы новый год посреди старого и стёр
   * бы полгода накопленных порогов.
   */
  if (month !== 7 || day !== 1) {
    log.info({ today }, 'не первое июля: сброс не выполняется');

    return { periodStart, residents: 0, thresholds: 0, skipped: true };
  }

  const run = await claimJobRun(RATING_YEAR_RESET_JOB, periodStart, executor);

  if (run === null) {
    log.info('год уже открыт');

    return { periodStart, residents: 0, thresholds: 0, skipped: true };
  }

  let residents = 0;
  let thresholds = 0;

  try {
    const networks = await executor.select({ id: organizations.id }).from(organizations);

    for (const network of networks) {
      const actor = await actorForOrg(network.id, executor);

      if (actor === null) {
        continue;
      }

      const living = await listResidencies(actor.context, { status: 'active' }, executor);

      for (const residency of living) {
        await createRatingEvent(
          actor.context,
          {
            userId: residency.userId,
            type: 'year_reset',
            delta: 0,
            note: 'Начало года рейтинга',
            effectiveAt: instant,
            periodStart,
          },
          executor,
        );

        residents += 1;

        /*
         * Пороги взводятся заново: снятый порог помнил падение прошлого
         * года, а рейтинг начинается с 50, и прошлое к нему отношения
         * не имеет. Долги ротаций сгорают сами — у них своя дата (§7).
         */
        const updated = await executor
          .update(ratingThresholdStates)
          .set({ armed: true, updatedAt: instant })
          .where(eq(ratingThresholdStates.userId, residency.userId))
          .returning({ id: ratingThresholdStates.id });

        thresholds += updated.length;
      }
    }
  } catch (error) {
    await finishJobRun(run.id, 'failed', { error: String(error) }, executor);
    throw error;
  }

  await finishJobRun(run.id, 'done', { residents, thresholds }, executor);
  log.info({ residents, thresholds }, 'год рейтинга открыт');

  return { periodStart, residents, thresholds, skipped: false };
}
