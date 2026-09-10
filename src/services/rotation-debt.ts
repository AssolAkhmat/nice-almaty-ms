import { getDb, type Executor } from '@/db/client';
import { syncAssignmentDebt } from '@/db/repositories/rotations';
import { contractEndDate } from '@/domain/contract';
import { debtStepOf, type DebtStep } from '@/domain/rotation-debt';

import type { RotationAssignment, RotationOccurrence } from '@/db/schema';
import type { BusinessDate } from '@/lib/time';

/**
 * Книга долга по дополнительным ротациям (docs/03-BUSINESS-RULES.md §7,
 * `docs/tasks/PHASE-10.md` §2.7, P10-3).
 *
 * Строка книги — следствие состояния назначения, а не отдельное действие:
 * «не выполнена» даёт `+1`, подтверждённая ротация с галочкой «списать
 * доп. ротацию» — `−1`, отмена снимает и то, и другое. Поэтому каждое
 * место, где меняется состояние назначения или его занятия, зовёт сюда
 * и получает книгу, согласную с расписанием.
 */
export const DEBT_REASONS = {
  missed: 'rotation.missed',
  writeOff: 'rotation.write_off',
} as const;

/**
 * Согласовать строку книги с назначением; возвращает шаг, который остался.
 *
 * Долг сгорает 1 июля (§7, P4-25) — считается от даты самой ротации:
 * пропуск в первом полугодии живёт до ближайшего июля, во втором —
 * до следующего. Списание сгорает в тот же день, что и начисление,
 * которое оно гасит.
 */
export async function syncDebtOf(
  assignment: RotationAssignment,
  occurrence: RotationOccurrence,
  executor: Executor = getDb(),
): Promise<DebtStep> {
  const step = debtStepOf({
    state: assignment.state,
    writeOffDebt: assignment.writeOffDebt,
    hasExecutor: assignment.userId !== null,
    cancelled: occurrence.status === 'cancelled',
  });

  await syncAssignmentDebt(
    {
      assignmentId: assignment.id,
      userId: assignment.userId,
      step,
      reason: step === -1 ? DEBT_REASONS.writeOff : DEBT_REASONS.missed,
      expiresAt: contractEndDate(occurrence.date as BusinessDate),
    },
    executor,
  );

  return step;
}
