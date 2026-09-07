import { and, asc, eq } from 'drizzle-orm';

import { getDb, type Executor } from '@/db/client';
import { claimJobRun, finishJobRun } from '@/db/repositories/job-runs';
import {
  listAssignmentsFor,
  listOccurrencesOfDate,
  updateAssignment,
  updateOccurrence,
} from '@/db/repositories/rotations';
import { organizations, rotationDebts, users } from '@/db/schema';
import { contractEndDate } from '@/domain/contract';
import { logger } from '@/lib/logger';
import { addDays, now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { AccessContext } from '@/db/access';
import type { UserActor } from './users';

/**
 * Автозакрытие дня ротаций (docs/03-BUSINESS-RULES.md §7).
 *
 * В 23:55 дня, следующего за днём ротации, неподтверждённое становится
 * «Не выполнена» с оценкой 1 и даёт +1 к долгу дополнительных ротаций.
 * У жильца, таким образом, есть весь следующий день — как и обещает §7.
 *
 * Событие рейтинга (−2) здесь не пишется: таблицы рейтинга появляются
 * в фазе 5, и это видно по коду, а не по умолчанию.
 */
export const ROTATIONS_CLOSE_DAY_JOB = 'rotations-close-day';

export interface CloseDayDeps {
  executor?: Executor;
  /** Момент запуска: из него выводится вчерашний день по календарю Алматы. */
  instant?: Date;
}

export interface CloseDayResult {
  /** День, который закрывали. */
  date: BusinessDate;
  /** Сколько назначений отмечено невыполненными. */
  closed: number;
  /** Сколько долгов начислено: у назначения без исполнителя долга нет. */
  debts: number;
  /** Прогон этого дня уже был. */
  skipped: boolean;
}

/**
 * Задание ходит от имени суперадмина сети: своего пользователя у расписания
 * нет, а репозитории без контекста доступа не отдают ничего (P3-16).
 */
async function actorForOrg(orgId: string, executor: Executor): Promise<UserActor | null> {
  const [superadmin] = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, 'superadmin')))
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

  return { context, requestId: `job:${ROTATIONS_CLOSE_DAY_JOB}` };
}

export async function closeRotationDay(deps: CloseDayDeps = {}): Promise<CloseDayResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  // Закрывается вчерашний день: сегодняшний жилец ещё вправе подтвердить.
  const date = addDays(todayInAlmaty(instant), -1);
  const log = logger.child({ job: ROTATIONS_CLOSE_DAY_JOB, date });

  const run = await claimJobRun(ROTATIONS_CLOSE_DAY_JOB, date, executor);

  if (run === null) {
    log.info('день уже закрыт');

    return { date, closed: 0, debts: 0, skipped: true };
  }

  let closed = 0;
  let debts = 0;

  try {
    const networks = await executor.select({ id: organizations.id }).from(organizations);

    for (const network of networks) {
      const actor = await actorForOrg(network.id, executor);

      if (actor === null) {
        continue;
      }

      const occurrences = await listOccurrencesOfDate(actor.context, date, executor);

      for (const occurrence of occurrences) {
        // Отменённое не влияет ни на рейтинг, ни на долг (§7), выполненное
        // закрывать незачем.
        if (occurrence.status !== 'scheduled') {
          continue;
        }

        const assignments = await listAssignmentsFor([occurrence.id], executor);
        const pending = assignments.filter(
          (assignment) =>
            assignment.state === 'assigned' || assignment.state === 'needs_reassignment',
        );

        if (pending.length === 0) {
          continue;
        }

        for (const assignment of pending) {
          await updateAssignment(
            assignment.id,
            { state: 'missed', score: 1, scoredAt: instant },
            executor,
          );
          closed += 1;

          // Долг получает человек, а не пустое место: у назначения без
          // исполнителя спрашивать некого — это задача админа (§6.3).
          if (assignment.userId !== null) {
            await executor.insert(rotationDebts).values({
              userId: assignment.userId,
              reason: 'rotation.missed',
              sourceAssignmentId: assignment.id,
              // Долг не сгорает и живёт до 1 июля — той же границы, что
              // и год рейтинга (§7).
              expiresAt: contractEndDate(date),
            });

            debts += 1;
          }
        }

        await updateOccurrence(actor.context, occurrence.id, { status: 'missed' }, executor);

        await recordAudit(
          { context: actor.context, requestId: actor.requestId },
          {
            action: AUDIT_ACTIONS.rotationMarked,
            entityType: 'rotation_occurrence',
            entityId: occurrence.id,
            after: { status: 'missed', closedBy: ROTATIONS_CLOSE_DAY_JOB, date },
          },
          executor,
        );
      }
    }
  } catch (error) {
    await finishJobRun(run.id, 'failed', { error: String(error) }, executor);
    throw error;
  }

  await finishJobRun(run.id, 'done', { closed, debts }, executor);
  log.info({ closed, debts }, 'день закрыт');

  return { date, closed, debts, skipped: false };
}
