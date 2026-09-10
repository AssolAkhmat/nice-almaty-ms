import { getDb, type Executor } from '@/db/client';
import {
  listAssignmentsById,
  listAssignmentsFor,
  requireOccurrence,
  updateAssignment,
  updateOccurrence,
} from '@/db/repositories/rotations';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { syncScoreEvent } from './rating';
import { syncDebtOf } from './rotation-debt';

import type { RotationAssignment, RotationOccurrence } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Подтверждение и оценка ротаций (docs/03-BUSINESS-RULES.md §7).
 *
 * Жилец подтверждает свою уборку сам: время, фото и комментарий. Оценку
 * ставит только админ, и видит её тоже только он — жильцу она не показывается
 * нигде, даже своя. Всё обратимо: админ правит статус и оценку задним числом.
 */
export interface ConfirmationDeps {
  executor?: Executor;
  /** Момент действия приходит снаружи: часы — не дело бизнес-логики. */
  instant?: Date;
}

function executorOf(deps: ConfirmationDeps): Executor {
  return deps.executor ?? getDb();
}

export interface ConfirmInput {
  /** Когда убрано; по умолчанию — момент подтверждения (§7). */
  doneAt?: Date;
  note?: string;
  photoFileIds?: readonly string[];
}

/** Назначение вместе с его занятием: без занятия непонятно, чей это дом. */
async function requireAssignment(
  actor: UserActor,
  assignmentId: string,
  executor: Executor,
): Promise<{ assignment: RotationAssignment; occurrence: RotationOccurrence }> {
  const [assignment] = await listAssignmentsById([assignmentId], executor);

  if (assignment === undefined) {
    throw new NotFoundError('Назначение не найдено');
  }

  const occurrence = await requireOccurrence(actor.context, assignment.occurrenceId, executor);

  return { assignment, occurrence };
}

/**
 * Подтверждение своей ротации жильцом.
 *
 * Чужое назначение неотличимо от несуществующего (P1-1): подтверждать
 * за соседа нельзя, и знать о его ротациях по идентификатору — тоже.
 */
export async function confirmAssignment(
  actor: UserActor,
  assignmentId: string,
  input: ConfirmInput,
  deps: ConfirmationDeps = {},
): Promise<RotationAssignment> {
  const executor = executorOf(deps);
  const instant = deps.instant ?? now();

  const { assignment, occurrence } = await requireAssignment(actor, assignmentId, executor);

  assertCan(actor.context, 'rotation.confirm', {
    houseId: occurrence.houseId,
    userId: assignment.userId ?? undefined,
  });

  // Отменённую уборку подтверждать нечем: она не состоялась и на рейтинг
  // не влияет (§7).
  if (occurrence.status === 'cancelled' || assignment.state === 'cancelled') {
    throw new ValidationError('rotationConfirmation.errors.cancelled');
  }

  return executor.transaction(async (tx) => {
    const confirmed = await updateAssignment(
      assignmentId,
      {
        state: 'confirmed',
        confirmedAt: instant,
        confirmedBy: actor.context.userId,
        doneAt: input.doneAt ?? instant,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.photoFileIds === undefined ? {} : { photoFileIds: [...input.photoFileIds] }),
      },
      tx,
    );

    // Списание — при подтверждении выполнения, не при постановке (P10-3).
    await syncDebtOf(confirmed, occurrence, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationConfirmed,
        entityType: 'rotation_occurrence',
        entityId: occurrence.id,
        after: { assignmentId, doneAt: (input.doneAt ?? instant).toISOString() },
      },
      tx,
    );

    return confirmed;
  });
}

export interface MarkInput {
  state: 'assigned' | 'confirmed' | 'missed';
  /** Оценка 1–10; ставится только админом и видна только ему (§7). */
  score?: number | null;
  note?: string;
}

export async function markAssignment(
  actor: UserActor,
  assignmentId: string,
  input: MarkInput,
  deps: ConfirmationDeps = {},
): Promise<RotationAssignment> {
  const executor = executorOf(deps);
  const instant = deps.instant ?? now();

  const { assignment, occurrence } = await requireAssignment(actor, assignmentId, executor);

  assertCan(actor.context, 'rotation.score', { houseId: occurrence.houseId });

  if (input.score !== undefined && input.score !== null) {
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 10) {
      throw new ValidationError('rotationConfirmation.errors.scoreRange');
    }
  }

  return executor.transaction(async (tx) => {
    const marked = await updateAssignment(
      assignmentId,
      {
        state: input.state,
        ...(input.state === 'confirmed'
          ? { confirmedAt: instant, confirmedBy: actor.context.userId, doneAt: instant }
          : {}),
        ...(input.score === undefined
          ? {}
          : {
              score: input.score,
              scoredBy: input.score === null ? null : actor.context.userId,
              scoredAt: input.score === null ? null : instant,
            }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      tx,
    );

    // Книга долга следует за отметкой: «не выполнена» +1, подтверждённое
    // с галочкой −1, возврат в расписание забирает строку (§7).
    await syncDebtOf(marked, occurrence, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action:
          input.score === undefined ? AUDIT_ACTIONS.rotationMarked : AUDIT_ACTIONS.rotationScored,
        entityType: 'rotation_occurrence',
        entityId: occurrence.id,
        before: { state: assignment.state, score: assignment.score },
        after: { assignmentId, state: input.state, score: input.score ?? null },
      },
      tx,
    );

    /*
     * Оценка — это и есть событие рейтинга (§5.2): дельта считается по
     * правилам дома. Переоценка задним числом правит ту же строку, а не
     * начисляет дельту второй раз.
     */
    if (marked.userId !== null) {
      await syncScoreEvent(
        actor,
        {
          userId: marked.userId,
          houseId: occurrence.houseId,
          assignmentId,
          score: marked.score,
          date: occurrence.date as BusinessDate,
          cancelled: occurrence.status === 'cancelled' || marked.state === 'cancelled',
        },
        { executor: tx, instant },
      );
    }

    return marked;
  });
}

/**
 * Статус занятия целиком: «Выполнена», «Не выполнена», «Отменена» —
 * и обратно. Обратимость требует §7: админ правит задним числом.
 */
export async function setOccurrenceStatus(
  actor: UserActor,
  occurrenceId: string,
  status: 'scheduled' | 'done' | 'missed' | 'cancelled',
  deps: ConfirmationDeps = {},
): Promise<RotationOccurrence> {
  const executor = executorOf(deps);

  const occurrence = await requireOccurrence(actor.context, occurrenceId, executor);

  assertCan(actor.context, 'rotation.manage', { houseId: occurrence.houseId });

  return executor.transaction(async (tx) => {
    const updated = await updateOccurrence(actor.context, occurrenceId, { status }, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationMarked,
        entityType: 'rotation_occurrence',
        entityId: occurrenceId,
        before: { status: occurrence.status },
        after: { status },
      },
      tx,
    );

    /*
     * «Отменена» снимает влияние на рейтинг и долг (§7), возврат в расписание —
     * возвращает: дельта пересчитывается по той же оценке, что стоит сейчас,
     * строка книги долга — по тому же состоянию назначения.
     */
    for (const assignment of await listAssignmentsFor([occurrenceId], tx)) {
      await syncDebtOf(assignment, updated, tx);

      if (assignment.userId === null) {
        continue;
      }

      await syncScoreEvent(
        actor,
        {
          userId: assignment.userId,
          houseId: occurrence.houseId,
          assignmentId: assignment.id,
          score: assignment.score,
          date: occurrence.date as BusinessDate,
          cancelled: status === 'cancelled' || assignment.state === 'cancelled',
        },
        { executor: tx, instant: deps.instant ?? now() },
      );
    }

    return updated;
  });
}
