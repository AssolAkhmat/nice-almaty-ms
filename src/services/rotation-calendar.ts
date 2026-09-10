import { getDb, type Executor } from '@/db/client';
import { listResidencies } from '@/db/repositories/residencies';
import {
  createAssignment,
  createOccurrence,
  deleteAssignment,
  listAssignmentsById,
  listCalendarDictionaries,
  listAssignmentsFor,
  listOccurrences,
  requireChecklist,
  requireOccurrence,
  updateAssignment,
  updateOccurrence,
} from '@/db/repositories/rotations';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { syncDebtOf } from './rotation-debt';

import type { CalendarDictionaries } from '@/db/repositories/rotations';
import type { RotationAssignment, RotationOccurrence } from '@/db/schema';
import type { OccurrenceView } from './rotation-schedule';
import type { UserActor } from './users';

/**
 * Календарь ротаций (docs/03-BUSINESS-RULES.md §6.6, docs/04-MODULES/03-rotations.md).
 *
 * Здесь живут действия админа над расписанием: перенос, отмена, ручное
 * назначение, внеплановая ротация и каникулы. Сетка ими не пересобирается —
 * она остаётся формулой, а календарь правит уже материализованное.
 */
export interface CalendarDeps {
  executor?: Executor;
  /** Дом; у жильца берётся из проживания и запросу не подчиняется. */
  houseId?: string;
}

function executorOf(deps: CalendarDeps): Executor {
  return deps.executor ?? getDb();
}

const EMPTY_DICTIONARIES: CalendarDictionaries = { areas: [], checklists: [], members: [] };

export interface CalendarView {
  houseId: string | null;
  occurrences: OccurrenceView[];
  /** Названия зон, чек-листов и имена жильцов: их показывают вместе с ротацией. */
  dictionaries: CalendarDictionaries;
}

/**
 * Дом, чей календарь читает актор.
 *
 * Админ называет свой дом сам; жильцу дом достаётся из проживания —
 * иначе перебором идентификаторов читался бы состав сети (P1-1).
 */
async function houseOfActor(
  actor: UserActor,
  deps: CalendarDeps,
  executor: Executor,
): Promise<string | null> {
  if (actor.context.role === 'resident') {
    const [residency] = await listResidencies(actor.context, {}, executor);

    return residency?.houseId ?? null;
  }

  return deps.houseId ?? actor.context.houseId;
}

export async function readCalendar(
  actor: UserActor,
  range: { from: BusinessDate; to: BusinessDate },
  deps: CalendarDeps = {},
): Promise<CalendarView> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.read', {
    houseId: deps.houseId ?? actor.context.houseId,
    userId: actor.context.userId,
  });

  const houseId = await houseOfActor(actor, deps, executor);

  if (houseId === null) {
    return { houseId: null, occurrences: [], dictionaries: EMPTY_DICTIONARIES };
  }

  const occurrences = await listOccurrences(actor.context, houseId, range, executor);
  const [assignments, dictionaries] = await Promise.all([
    listAssignmentsFor(
      occurrences.map((occurrence) => occurrence.id),
      executor,
    ),
    listCalendarDictionaries(actor.context, houseId, executor),
  ]);

  /*
   * Оценка видна только админу и суперадмину (§7). Жильцу она не показывается
   * нигде — ни своя, ни соседская, — поэтому вычищается здесь, в единственном
   * месте чтения календаря, а не в каждом экране по отдельности.
   */
  const hideScores = actor.context.role === 'resident';

  return {
    houseId,
    occurrences: occurrences.map((occurrence) => ({
      occurrence,
      assignments: assignments
        .filter((item) => item.occurrenceId === occurrence.id)
        .map((item) =>
          hideScores ? { ...item, score: null, scoredBy: null, scoredAt: null } : item,
        ),
    })),
    dictionaries,
  };
}

/** Занятие вместе с проверкой права им управлять. */
async function requireManagedOccurrence(
  actor: UserActor,
  occurrenceId: string,
  executor: Executor,
): Promise<RotationOccurrence> {
  assertCan(actor.context, 'rotation.manage', { houseId: actor.context.houseId });

  return requireOccurrence(actor.context, occurrenceId, executor);
}

/**
 * Перенос занятия на другую дату (§6.6).
 *
 * Номер недели `cycle_index` остаётся прежним: перенос двигает день, а не
 * место в цикле, и ряд от него не пересобирается. Прежняя дата остаётся
 * видимой в `moved_from_date` — в календаре понятно, откуда занятие пришло.
 */
export async function moveOccurrence(
  actor: UserActor,
  occurrenceId: string,
  date: BusinessDate,
  deps: CalendarDeps = {},
): Promise<RotationOccurrence> {
  const executor = executorOf(deps);

  const occurrence = await requireManagedOccurrence(actor, occurrenceId, executor);

  if (occurrence.date === date) {
    return occurrence;
  }

  // Ряд, зона и дата — уникальны: занятие нельзя перенести туда, где такое же
  // уже стоит, иначе в один день у зоны оказалось бы две уборки подряд.
  if (occurrence.rowId !== null) {
    const sameDay = await listOccurrences(
      actor.context,
      occurrence.houseId,
      { from: date, to: date },
      executor,
    );

    const clash = sameDay.some(
      (item) => item.rowId === occurrence.rowId && item.areaId === occurrence.areaId,
    );

    if (clash) {
      throw new ValidationError('rotationCalendar.errors.dateTaken');
    }
  }

  return executor.transaction(async (tx) => {
    const moved = await updateOccurrence(
      actor.context,
      occurrenceId,
      {
        date,
        // Первая дата и остаётся исходной: два переноса подряд не должны
        // стирать след того, откуда занятие пришло изначально.
        movedFromDate: parseBusinessDate(occurrence.movedFromDate ?? occurrence.date),
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationMoved,
        entityType: 'rotation_occurrence',
        entityId: occurrenceId,
        before: { date: occurrence.date },
        after: { date },
      },
      tx,
    );

    return moved;
  });
}

/**
 * Отмена занятия. Отменённое не влияет ни на рейтинг, ни на долг (§7),
 * поэтому вместе с ним отменяются и его назначения: иначе автозакрытие дня
 * посчитало бы их невыполненными.
 */
export async function cancelOccurrence(
  actor: UserActor,
  occurrenceId: string,
  deps: CalendarDeps = {},
): Promise<RotationOccurrence> {
  const executor = executorOf(deps);

  const occurrence = await requireManagedOccurrence(actor, occurrenceId, executor);

  return executor.transaction(async (tx) => {
    const cancelled = await updateOccurrence(
      actor.context,
      occurrenceId,
      { status: 'cancelled' },
      tx,
    );

    for (const assignment of await listAssignmentsFor([occurrenceId], tx)) {
      if (assignment.state === 'cancelled') {
        continue;
      }

      const off = await updateAssignment(assignment.id, { state: 'cancelled' }, tx);
      // Отменённое не влияет на долг (§7): строка книги уходит вместе с ним.
      await syncDebtOf(off, cancelled, tx);
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationCancelled,
        entityType: 'rotation_occurrence',
        entityId: occurrenceId,
        before: { status: occurrence.status, date: occurrence.date },
      },
      tx,
    );

    return cancelled;
  });
}

/**
 * Каникулы: массовая отмена по диапазону дат (§6.6).
 *
 * Отменяется только запланированное. Выполненное и уже отменённое остаётся
 * как есть: каникулы — это про будущее, а не про переписывание истории.
 */
export async function cancelRange(
  actor: UserActor,
  houseId: string,
  range: { from: BusinessDate; to: BusinessDate },
  deps: CalendarDeps = {},
): Promise<number> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.manage', { houseId });

  const occurrences = await listOccurrences(actor.context, houseId, range, executor);
  const scheduled = occurrences.filter((occurrence) => occurrence.status === 'scheduled');

  if (scheduled.length === 0) {
    return 0;
  }

  return executor.transaction(async (tx) => {
    for (const occurrence of scheduled) {
      await updateOccurrence(actor.context, occurrence.id, { status: 'cancelled' }, tx);

      for (const assignment of await listAssignmentsFor([occurrence.id], tx)) {
        if (assignment.state === 'cancelled') {
          continue;
        }

        await updateAssignment(assignment.id, { state: 'cancelled' }, tx);
      }
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationRangeCancelled,
        entityType: 'house',
        entityId: houseId,
        after: { from: range.from, to: range.to, cancelled: scheduled.length },
      },
      tx,
    );

    return scheduled.length;
  });
}

/** Житель дома: только он может стать исполнителем его ротации. */
async function assertHouseResident(
  actor: UserActor,
  houseId: string,
  userId: string,
  executor: Executor,
): Promise<void> {
  const residencies = await listResidencies(actor.context, { houseId }, executor);

  if (!residencies.some((residency) => residency.userId === userId)) {
    // Жилец другого дома неотличим от несуществующего (P1-1).
    throw new NotFoundError('Жилец не найден');
  }
}

/**
 * Переназначение исполнителя (§6.6). Пустой `userId` снимает исполнителя
 * и возвращает назначение в «требует решения»: дыра остаётся видимой.
 */
export async function reassignAssignment(
  actor: UserActor,
  assignmentId: string,
  userId: string | null,
  deps: CalendarDeps = {},
): Promise<RotationAssignment> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.manage', { houseId: actor.context.houseId });

  const [assignment] = await listAssignmentsById([assignmentId], executor);
  if (assignment === undefined) {
    throw new NotFoundError('Назначение не найдено');
  }

  const occurrence = await requireOccurrence(actor.context, assignment.occurrenceId, executor);

  if (userId !== null) {
    await assertHouseResident(actor, occurrence.houseId, userId, executor);
  }

  return executor.transaction(async (tx) => {
    const updated = await updateAssignment(
      assignmentId,
      {
        userId,
        source: 'manual',
        state: userId === null ? 'needs_reassignment' : 'assigned',
        // Списание принадлежит тому, кого ставили с галочкой (§2.7): другому
        // человеку оно не переходит, его ставят заново, если нужно.
        writeOffDebt: false,
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationReassigned,
        entityType: 'rotation_occurrence',
        entityId: occurrence.id,
        before: { userId: assignment.userId },
        after: { userId },
      },
      tx,
    );

    return updated;
  });
}

export interface ExtraOccurrenceInput {
  houseId: string;
  areaId: string;
  checklistId: string;
  date: BusinessDate;
  /** Кого ставят убирать. Пусто — занятие ждёт решения админа. */
  userIds: readonly string[];
  /** Галочка «списать доп. ротацию» у каждого поставленного (§7, §2.7). */
  writeOffDebt?: boolean;
}

/**
 * Внеплановая ротация (§6.6): вне ряда и вне сетки.
 *
 * Ряда у неё нет, поэтому уникальность «ряд, зона, дата» её не касается:
 * админ вправе назначить вторую уборку той же зоны в тот же день.
 */
export async function createExtraOccurrence(
  actor: UserActor,
  input: ExtraOccurrenceInput,
  deps: CalendarDeps = {},
): Promise<RotationOccurrence> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.manage', { houseId: input.houseId });

  const checklist = await requireChecklist(actor.context, input.checklistId, executor);
  if (checklist.areaId !== input.areaId) {
    throw new ValidationError('rotationCalendar.errors.checklistArea');
  }

  for (const userId of input.userIds) {
    await assertHouseResident(actor, input.houseId, userId, executor);
  }

  return executor.transaction(async (tx) => {
    const occurrence = await createOccurrence(
      actor.context,
      {
        houseId: input.houseId,
        areaId: input.areaId,
        checklistId: input.checklistId,
        date: input.date,
        type: 'extra',
        createdBy: actor.context.userId,
      },
      tx,
    );

    const targets = input.userIds.length === 0 ? [null] : [...input.userIds];
    const writeOffDebt = input.writeOffDebt === true;

    for (const userId of targets) {
      await createAssignment(
        actor.context,
        {
          occurrenceId: occurrence.id,
          userId,
          source: writeOffDebt && userId !== null ? 'debt' : 'manual',
          state: userId === null ? 'needs_reassignment' : 'assigned',
          writeOffDebt: writeOffDebt && userId !== null,
        },
        tx,
      );
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationExtraCreated,
        entityType: 'rotation_occurrence',
        entityId: occurrence.id,
        after: {
          areaId: input.areaId,
          date: input.date,
          userIds: [...input.userIds],
          writeOffDebt,
        },
      },
      tx,
    );

    return occurrence;
  });
}

/**
 * Снять одного исполнителя с зоны на дату (план фазы 10 §2.6, «двор 2 → 1»).
 *
 * Правка одной недели: назначение уходит, у занятия становится на человека
 * меньше, базовый цикл не трогается — следующая неделя идёт по норме.
 * Инвариант 8 держится: число назначений остаётся равным числу людей
 * занятия. Последнего исполнителя не снимают: зону на дату отменяют
 * (`cancelOccurrence`), а занятие без людей ничего бы не значило.
 */
export async function removeAssignment(
  actor: UserActor,
  assignmentId: string,
  deps: CalendarDeps = {},
): Promise<RotationOccurrence> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.manage', { houseId: actor.context.houseId });

  const [assignment] = await listAssignmentsById([assignmentId], executor);
  if (assignment === undefined) {
    throw new NotFoundError('Назначение не найдено');
  }

  const occurrence = await requireOccurrence(actor.context, assignment.occurrenceId, executor);

  if (occurrence.status !== 'scheduled') {
    throw new ValidationError('rotationCalendar.errors.notScheduled');
  }

  // Подтверждённое и невыполненное — уже история с оценкой и долгом;
  // её правят отметкой (§7), а не снятием.
  if (assignment.state !== 'assigned' && assignment.state !== 'needs_reassignment') {
    throw new ValidationError('rotationCalendar.errors.assignmentSettled');
  }

  const siblings = await listAssignmentsFor([occurrence.id], executor);
  if (siblings.length <= 1) {
    throw new ValidationError('rotationCalendar.errors.lastAssignment');
  }

  return executor.transaction(async (tx) => {
    await deleteAssignment(assignmentId, tx);

    const updated = await updateOccurrence(
      actor.context,
      occurrence.id,
      { peopleNeeded: Math.max(occurrence.peopleNeeded - 1, 1) },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationAssignmentRemoved,
        entityType: 'rotation_occurrence',
        entityId: occurrence.id,
        before: { userId: assignment.userId, peopleNeeded: occurrence.peopleNeeded },
        after: { peopleNeeded: updated.peopleNeeded },
      },
      tx,
    );

    return updated;
  });
}

export interface PlaceInput {
  occurrenceId: string;
  userId: string;
  /** «Списать доп. ротацию»: при подтверждении выполнения долг −1 (§7, P10-3). */
  writeOffDebt?: boolean;
}

/**
 * Поставить человека на зону дня (план фазы 10 §2.7): в дырку или сверх нормы.
 *
 * Одно действие на два случая. Есть назначение без исполнителя — человек
 * встаёт в него, число людей не меняется. Дырки нет — заводится назначение
 * сверх нормы, и у занятия становится на человека больше (инвариант 8).
 * Галочка помечает назначение; сама книга долга правится при подтверждении,
 * а не здесь (P10-3). Допуск к зоне не проверяется: система предлагает,
 * админ решает (§2.8).
 */
export async function placeOnOccurrence(
  actor: UserActor,
  input: PlaceInput,
  deps: CalendarDeps = {},
): Promise<RotationAssignment> {
  const executor = executorOf(deps);

  const occurrence = await requireManagedOccurrence(actor, input.occurrenceId, executor);

  if (occurrence.status !== 'scheduled') {
    throw new ValidationError('rotationCalendar.errors.notScheduled');
  }

  await assertHouseResident(actor, occurrence.houseId, input.userId, executor);

  const assignments = await listAssignmentsFor([occurrence.id], executor);

  if (assignments.some((item) => item.userId === input.userId && item.state !== 'cancelled')) {
    throw new ValidationError('rotationCalendar.errors.alreadyAssigned');
  }

  const hole = assignments.find(
    (item) => item.userId === null && item.state === 'needs_reassignment',
  );
  const writeOffDebt = input.writeOffDebt === true;
  const source = writeOffDebt ? 'debt' : 'manual';

  return executor.transaction(async (tx) => {
    const placed =
      hole === undefined
        ? await createAssignment(
            actor.context,
            {
              occurrenceId: occurrence.id,
              userId: input.userId,
              source,
              state: 'assigned',
              writeOffDebt,
            },
            tx,
          )
        : await updateAssignment(
            hole.id,
            { userId: input.userId, source, state: 'assigned', writeOffDebt },
            tx,
          );

    const peopleNeeded = hole === undefined ? occurrence.peopleNeeded + 1 : occurrence.peopleNeeded;

    if (hole === undefined) {
      await updateOccurrence(actor.context, occurrence.id, { peopleNeeded }, tx);
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationPlaced,
        entityType: 'rotation_occurrence',
        entityId: occurrence.id,
        after: {
          userId: input.userId,
          writeOffDebt,
          filledHole: hole !== undefined,
          peopleNeeded,
        },
      },
      tx,
    );

    return placed;
  });
}
