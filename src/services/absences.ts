import { getDb, type Executor } from '@/db/client';
import {
  createAbsence,
  listAbsences,
  requireAbsence,
  updateAbsence,
} from '@/db/repositories/rating';
import { listResidencies } from '@/db/repositories/residencies';
import { listCalendarDictionaries } from '@/db/repositories/rotations';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { compareBusinessDates, now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { Absence } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Отсутствия (docs/03-BUSINESS-RULES.md §9, docs/04-MODULES/05-presence.md).
 *
 * Три типа с разными последствиями. Краткосрочное фиксируется фактом —
 * одобрения оно не требует, и держать его в очереди значило бы просить
 * админа подтверждать то, на что он не влияет. Долгосрочное и болезнь
 * ждут решения.
 */
export interface AbsenceDeps {
  executor?: Executor;
  today?: BusinessDate;
  instant?: Date;
}

function executorOf(deps: AbsenceDeps): Executor {
  return deps.executor ?? getDb();
}

export interface SubmitAbsenceInput {
  type: 'short' | 'long' | 'sick';
  startDate: BusinessDate;
  endDate?: BusinessDate | null;
  /** Ориентировочное время возвращения — только у краткосрочного. */
  startAt?: Date | null;
  reason: string;
  docFileId?: string | null;
}

/** Дом жильца берётся из проживания: колонки дома у него нет (D11). */
async function houseOfResident(
  actor: UserActor,
  executor: Executor,
): Promise<{ houseId: string; userId: string }> {
  const [residency] = await listResidencies(actor.context, {}, executor);

  if (residency === undefined) {
    throw new NotFoundError('Проживание не найдено');
  }

  return { houseId: residency.houseId, userId: residency.userId };
}

export async function submitAbsence(
  actor: UserActor,
  input: SubmitAbsenceInput,
  deps: AbsenceDeps = {},
): Promise<Absence> {
  const executor = executorOf(deps);
  const today = deps.today ?? todayInAlmaty();
  const instant = deps.instant ?? now();

  const reason = input.reason.trim();
  if (reason === '') {
    // Причина обязательна во всех типах — §9 называет это прямо.
    throw new ValidationError('absences.errors.reasonRequired');
  }

  // Долгосрочное подаётся минимум за день: минимальная дата начала — завтра.
  if (input.type === 'long' && compareBusinessDates(input.startDate, today) <= 0) {
    throw new ValidationError('absences.errors.longTooLate');
  }

  if (
    input.endDate !== undefined &&
    input.endDate !== null &&
    compareBusinessDates(input.endDate, input.startDate) < 0
  ) {
    throw new ValidationError('absences.errors.endBeforeStart');
  }

  const { houseId, userId } = await houseOfResident(actor, executor);

  assertCan(actor.context, 'absence.create', { houseId, userId });

  return executor.transaction(async (tx) => {
    const absence = await createAbsence(
      actor.context,
      {
        userId,
        houseId,
        type: input.type,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        startAt: input.startAt ?? null,
        reason,
        docFileId: input.docFileId ?? null,
      },
      tx,
    );

    /*
     * Краткосрочное одобряется само: §9 фиксирует его фактом. Автор решения
     * при этом — сам жилец, и в журнале видно, что админ тут ни при чём.
     */
    const settled =
      input.type === 'short'
        ? await updateAbsence(
            actor.context,
            absence.id,
            { status: 'approved', reviewedBy: actor.context.userId, reviewedAt: instant },
            tx,
          )
        : absence;

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.absenceSubmitted,
        entityType: 'absence',
        entityId: absence.id,
        after: {
          type: input.type,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          status: settled.status,
        },
      },
      tx,
    );

    return settled;
  });
}

export async function listMyAbsences(actor: UserActor, deps: AbsenceDeps = {}): Promise<Absence[]> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'absence.read', {
    houseId: actor.context.houseId,
    userId: actor.context.userId,
  });

  return listAbsences(actor.context, { userId: actor.context.userId }, executor);
}

export interface HouseAbsenceView {
  absence: Absence;
  /** Имя жильца: календарь дома читает человек. */
  name: string;
}

export async function listHouseAbsences(
  actor: UserActor,
  houseId: string,
  filter: { status?: 'pending' | 'approved' | 'rejected'; type?: 'short' | 'long' | 'sick' } = {},
  deps: AbsenceDeps = {},
): Promise<HouseAbsenceView[]> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'absence.read', { houseId, userId: actor.context.userId });

  const [rows, dictionaries] = await Promise.all([
    listAbsences(actor.context, { houseId, ...filter }, executor),
    listCalendarDictionaries(actor.context, houseId, executor),
  ]);

  const names = new Map(dictionaries.members.map((member) => [member.userId, member.name]));

  return rows.map((absence) => ({ absence, name: names.get(absence.userId) ?? '—' }));
}

async function review(
  actor: UserActor,
  absenceId: string,
  decision: 'approved' | 'rejected',
  note: string | null,
  deps: AbsenceDeps,
): Promise<Absence> {
  const executor = executorOf(deps);
  const instant = deps.instant ?? now();

  const existing = await requireAbsence(actor.context, absenceId, executor);

  assertCan(actor.context, 'absence.review', { houseId: existing.houseId });

  return executor.transaction(async (tx) => {
    const updated = await updateAbsence(
      actor.context,
      absenceId,
      {
        status: decision,
        reviewedBy: actor.context.userId,
        reviewedAt: instant,
        reviewNote: note,
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action:
          decision === 'approved' ? AUDIT_ACTIONS.absenceApproved : AUDIT_ACTIONS.absenceRejected,
        entityType: 'absence',
        entityId: absenceId,
        before: { status: existing.status },
        after: { status: decision, note },
      },
      tx,
    );

    return updated;
  });
}

export async function approveAbsence(
  actor: UserActor,
  absenceId: string,
  deps: AbsenceDeps = {},
): Promise<Absence> {
  return review(actor, absenceId, 'approved', null, deps);
}

/** Отклонение всегда с причиной: жилец должен понимать, почему ему отказали. */
export async function rejectAbsence(
  actor: UserActor,
  absenceId: string,
  note: string,
  deps: AbsenceDeps = {},
): Promise<Absence> {
  const trimmed = note.trim();

  if (trimmed === '') {
    throw new ValidationError('absences.errors.rejectReasonRequired');
  }

  return review(actor, absenceId, 'rejected', trimmed, deps);
}
