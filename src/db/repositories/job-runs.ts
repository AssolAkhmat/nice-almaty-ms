import { and, eq } from 'drizzle-orm';

import { now } from '@/lib/time';

import { getDb, type Executor } from '../client';
import { jobRuns, type JobRun } from '../schema';

/**
 * Прогоны заданий планировщика (docs/01-ARCHITECTURE.md, «Планировщик»).
 *
 * Таблица инфраструктурная: `org_id` в ней нет, контекста доступа она
 * не требует. Задания дёргаются по секрету расписания, а не пользователем.
 */
export type JobStatus = 'running' | 'done' | 'failed';

/**
 * Заявка на прогон. Возвращает `null`, если период уже отработан успешно:
 * повторный вызов за тот же месяц ничего не дублирует.
 *
 * Неудачный и оборванный прогон повторить можно — и нужно: часть работы
 * могла не дойти до конца. От дублей защищает не эта строка, а проверка
 * «счёт за месяц уже есть» в самом задании: одной защиты мало, если процесс
 * упал посередине.
 */
export async function claimJobRun(
  job: string,
  periodKey: string,
  executor: Executor = getDb(),
): Promise<JobRun | null> {
  const [inserted] = await executor
    .insert(jobRuns)
    .values({ job, periodKey, status: 'running' satisfies JobStatus })
    .onConflictDoNothing({ target: [jobRuns.job, jobRuns.periodKey] })
    .returning();

  if (inserted !== undefined) {
    return inserted;
  }

  const [existing] = await executor
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.job, job), eq(jobRuns.periodKey, periodKey)))
    .limit(1);

  if (existing === undefined || existing.status === 'done') {
    return null;
  }

  const [retaken] = await executor
    .update(jobRuns)
    .set({ status: 'running' satisfies JobStatus, startedAt: now(), updatedAt: now() })
    .where(eq(jobRuns.id, existing.id))
    .returning();

  return retaken ?? null;
}

export async function finishJobRun(
  id: string,
  status: JobStatus,
  result: unknown,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(jobRuns)
    .set({ status, result, finishedAt: now(), updatedAt: now() })
    .where(eq(jobRuns.id, id));
}
