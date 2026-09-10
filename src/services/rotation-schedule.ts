import { getDb, type Executor } from '@/db/client';
import { listApprovedAbsences } from '@/db/repositories/rating';
import {
  createAssignment,
  createOccurrence,
  listAreaEligibility,
  listAssignmentsFor,
  listBedOccupantsOn,
  listDayNorms,
  listEligibilityGroups,
  listEligibilityMembers,
  listOccurrences,
  listRotationRows,
  listRowRosters,
  requireRotationRow,
  updateAssignment,
} from '@/db/repositories/rotations';
import { parseEligibilityRule, resolveEligibility } from '@/domain/eligibility';
import { dayPlan, effectiveVersion, type PlannedAssignment } from '@/domain/rotation-day';
import { assertCan } from '@/lib/authz';
import {
  addDays,
  compareBusinessDates,
  differenceInDays,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import type { RotationAssignment, RotationOccurrence, RotationRow } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Материализация расписания ротаций (docs/03-BUSINESS-RULES.md §6.3, §6.6,
 * `docs/tasks/PHASE-10.md` §2.4).
 *
 * Расписание живёт в базе занятиями, а не считается на лету: занятие можно
 * перенести, отменить и переназначить. Раскладка при этом остаётся формулой —
 * `src/domain/rotation-day.ts`, — и генерация только приносит ей состав ряда,
 * норму дня и нынешних жильцов мест, а потом кладёт результат в календарь.
 */
export interface ScheduleDeps {
  executor?: Executor;
  /** «Сегодня» приходит снаружи: прямой `new Date()` в бизнес-логике запрещён. */
  today?: BusinessDate;
}

function executorOf(deps: ScheduleDeps): Executor {
  return deps.executor ?? getDb();
}

const DAYS_IN_WEEK = 7;

/**
 * Кто отсутствует в этот день по одобренному отъезду или болезни (§9).
 *
 * Освобождение касается только общих зон: комнатные и генеральные уборки
 * админ переносит или переназначает руками, и снимать их автоматически
 * значило бы решать за него.
 */
export async function absentOn(
  actor: UserActor,
  houseId: string,
  date: BusinessDate,
  executor: Executor,
): Promise<Set<string>> {
  const rows = await listApprovedAbsences(
    actor.context,
    houseId,
    { from: date, to: date },
    executor,
  );

  return new Set(
    rows.filter((row) => row.type === 'long' || row.type === 'sick').map((row) => row.userId),
  );
}

/** Освобождает ли отсутствие от этой уборки: только обычная общая зона (§9). */
function freedByAbsence(type: 'regular' | 'room' | 'general' | 'extra'): boolean {
  return type === 'regular';
}

export interface OccurrenceView {
  occurrence: RotationOccurrence;
  assignments: RotationAssignment[];
}

export async function readSchedule(
  actor: UserActor,
  houseId: string,
  range: { from: BusinessDate; to: BusinessDate },
  deps: ScheduleDeps = {},
): Promise<OccurrenceView[]> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.read', { houseId });

  const occurrences = await listOccurrences(actor.context, houseId, range, executor);
  const assignments = await listAssignmentsFor(
    occurrences.map((occurrence) => occurrence.id),
    executor,
  );

  return occurrences.map((occurrence) => ({
    occurrence,
    assignments: assignments.filter((item) => item.occurrenceId === occurrence.id),
  }));
}

/** Даты ряда от `from` до `until` включительно: каждые семь дней от старта. */
function rowDates(
  startDate: BusinessDate,
  from: BusinessDate,
  until: BusinessDate,
): BusinessDate[] {
  if (compareBusinessDates(until, startDate) < 0) {
    return [];
  }

  const skipped = Math.max(0, Math.ceil(differenceInDays(startDate, from) / DAYS_IN_WEEK));
  const dates: BusinessDate[] = [];

  for (
    let date = addDays(startDate, skipped * DAYS_IN_WEEK);
    compareBusinessDates(date, until) <= 0;
    date = addDays(date, DAYS_IN_WEEK)
  ) {
    dates.push(date);
  }

  return dates;
}

/**
 * Кого группы допуска пускают к каждой зоне дома (§6.1).
 *
 * Зона без групп в ответе не участвует вовсе: ядро считает такую зону
 * открытой для всех. Групп у зоны может быть несколько — они складываются,
 * потому что каждая говорит «эти вправе», а не «только эти».
 */
export async function eligibilityOfHouse(
  actor: UserActor,
  houseId: string,
  executor: Executor,
): Promise<Record<string, string[]>> {
  const [groups, links, members] = await Promise.all([
    listEligibilityGroups(actor.context, houseId, executor),
    listAreaEligibility(actor.context, houseId, executor),
    listEligibilityMembers(actor.context, houseId, executor),
  ]);

  const groupById = new Map(groups.map((group) => [group.id, group]));
  const people = members.map((member) => ({
    userId: member.userId,
    sex: member.sex,
    areaId: member.areaId,
  }));

  const byArea: Record<string, string[]> = {};

  for (const link of links) {
    if (link.checklistType !== 'regular') {
      continue;
    }

    const group = groupById.get(link.groupId);

    if (group === undefined) {
      continue;
    }

    const allowed = resolveEligibility(parseEligibilityRule(group.rule), people);

    byArea[link.areaId] = [...new Set([...(byArea[link.areaId] ?? []), ...allowed])];
  }

  return byArea;
}

export interface GenerateResult {
  /** Сколько занятий заведено этим вызовом. */
  created: number;
}

/**
 * «Сгенерировать расписание до <дата>» (§6.6).
 *
 * Занятия заводятся от сегодняшнего дня: прошлое задним числом не появляется,
 * иначе в календаре возникли бы просроченные ротации, которых никто не видел.
 * Повторный вызов того же периода ничего не создаёт — за это отвечает
 * уникальность `(row_id, area_id, date)` и проверка перед вставкой.
 */
export async function generateSchedule(
  actor: UserActor,
  houseId: string,
  until: BusinessDate,
  deps: ScheduleDeps = {},
): Promise<GenerateResult> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.write', { houseId });

  const today = deps.today ?? todayInAlmaty();
  const rows = await listRotationRows(actor.context, houseId, {}, executor);

  let created = 0;

  for (const row of rows) {
    created += await generateRow(actor, houseId, row, today, until, executor);
  }

  return { created };
}

/**
 * Занятия одного ряда в промежутке дат — общая часть генерации и пересборки
 * после правки «с даты» (§2.6). Занятия, которые уже есть, не трогаются.
 */
export async function regenerateRow(
  actor: UserActor,
  houseId: string,
  rowId: string,
  range: { from: BusinessDate; until: BusinessDate },
  deps: ScheduleDeps = {},
): Promise<number> {
  const executor = executorOf(deps);
  const row = await requireRotationRow(actor.context, rowId, executor);

  return generateRow(actor, houseId, row, range.from, range.until, executor);
}

async function generateRow(
  actor: UserActor,
  houseId: string,
  row: RotationRow,
  today: BusinessDate,
  until: BusinessDate,
  executor: Executor,
): Promise<number> {
  const eligibleByArea = await eligibilityOfHouse(actor, houseId, executor);

  let created = 0;

  const [rosters, norms] = await Promise.all([
    listRowRosters(actor.context, row.id, executor),
    listDayNorms(actor.context, row.id, executor),
  ]);

  // Ряд без состава или без нормы не расписывается: догадываться, кого
  // и на какие зоны поставить, система не вправе.
  if (rosters.length === 0 || norms.length === 0) {
    return 0;
  }

  {
    const rowStartDate = row.startDate as BusinessDate;
    const occurrenceType = row.type === 'room' ? 'room' : 'regular';

    for (const date of rowDates(rowStartDate, today, until)) {
      if (effectiveVersion(rosters, date) === null || effectiveVersion(norms, date) === null) {
        continue;
      }

      // Кто где живёт — на дату занятия, а не на день генерации: место может
      // освободиться между ними, и тогда назначение сразу ждёт решения админа.
      const occupants = Object.fromEntries(
        (await listBedOccupantsOn(actor.context, houseId, date, executor)).map((occupant) => [
          occupant.bedId,
          occupant.userId,
        ]),
      );

      /*
       * Отсутствующий не убирает только общую зону (§9): комнатную и генеральную
       * админ переносит руками, и снимать их автоматически значило бы решать
       * за него.
       */
      const absent = freedByAbsence(occurrenceType)
        ? await absentOn(actor, houseId, date, executor)
        : new Set<string>();

      const plan = dayPlan({
        rowStartDate,
        date,
        rosters,
        norms,
        occupants,
        absentUserIds: [...absent],
        eligibleByArea,
      });

      /** Назначения одного занятия: зона с чек-листом — это и есть занятие. */
      const byZone = new Map<string, PlannedAssignment[]>();

      for (const assignment of plan.assignments) {
        const key = `${assignment.areaId}|${assignment.checklistId}`;
        byZone.set(key, [...(byZone.get(key) ?? []), assignment]);
      }

      const existing = await listOccurrences(
        actor.context,
        houseId,
        { from: date, to: date },
        executor,
      );

      for (const group of byZone.values()) {
        const first = group[0];

        if (first === undefined) {
          continue;
        }

        const already = existing.find(
          (occurrence) => occurrence.rowId === row.id && occurrence.areaId === first.areaId,
        );

        // Занятие этого дня уже есть — вместе с отменённым и перенесённым:
        // повторная генерация не воскрешает то, что админ убрал (§6.6).
        if (already !== undefined) {
          continue;
        }

        const occurrence = await createOccurrence(
          actor.context,
          {
            houseId,
            rowId: row.id,
            areaId: first.areaId,
            checklistId: first.checklistId,
            date,
            type: occurrenceType,
            cycleIndex: plan.week,
            // Число людей занятия — из нормы дня, а не из чек-листа (§2.3):
            // по нему считается инвариант 8 и правится неделя.
            peopleNeeded: group.length,
          },
          executor,
        );

        created += 1;

        for (const assignment of group) {
          await createAssignment(
            actor.context,
            {
              occurrenceId: occurrence.id,
              userId: assignment.userId,
              slotPosition: assignment.position,
              source: 'auto',
              // Дырка не исчезает из расписания: админ видит задачу
              // «отмени или назначь вручную» (§6.3), а не молчаливую дыру.
              state: assignment.userId === null ? 'needs_reassignment' : 'assigned',
              emptyReason: assignment.emptyReason,
              queuedUserId: assignment.queuedUserId,
            },
            executor,
          );
        }
      }
    }
  }

  return created;
}

/**
 * Пересчёт исполнителей у будущих занятий (§6.6).
 *
 * Заселение и выселение внутри месяца меняют, кто стоит за местом, — сетка
 * при этом та же. Прошлое не трогается: его уже видели люди. Назначения,
 * поставленные руками или в счёт долга, тоже не трогаются: их выбрал админ.
 */
export async function refreshFutureAssignments(
  actor: UserActor,
  houseId: string,
  from: BusinessDate,
  deps: ScheduleDeps = {},
): Promise<number> {
  assertCan(actor.context, 'settings.house.write', { houseId });

  return syncFutureAssignments(actor, houseId, from, deps);
}

/**
 * Тот же пересчёт, но системным путём — без отдельного права (P3-1).
 *
 * Его вызывают заселение и освобождение места: право на них уже проверено
 * по самой операции, а требовать сверх него право на настройку дома значило бы
 * запретить заселение тому, кто вправе заселять.
 */
export async function syncFutureAssignments(
  actor: UserActor,
  houseId: string,
  from: BusinessDate,
  deps: ScheduleDeps = {},
): Promise<number> {
  const executor = executorOf(deps);

  const horizon = addDays(from, 366);
  const occurrences = await listOccurrences(
    actor.context,
    houseId,
    { from, to: horizon },
    executor,
  );

  const scheduled = occurrences.filter(
    (occurrence) => occurrence.status === 'scheduled' && occurrence.rowId !== null,
  );

  if (scheduled.length === 0) {
    return 0;
  }

  const assignments = await listAssignmentsFor(
    scheduled.map((occurrence) => occurrence.id),
    executor,
  );

  const rostersByRow = new Map<string, Awaited<ReturnType<typeof listRowRosters>>>();
  const occupantsByDate = new Map<string, Map<string, string>>();
  const absentByDate = new Map<string, Set<string>>();
  let changed = 0;

  for (const occurrence of scheduled) {
    const rowId = occurrence.rowId ?? '';

    if (!rostersByRow.has(rowId)) {
      rostersByRow.set(rowId, await listRowRosters(actor.context, rowId, executor));
    }

    if (!occupantsByDate.has(occurrence.date)) {
      const [occupants, absent] = await Promise.all([
        listBedOccupantsOn(actor.context, houseId, occurrence.date as BusinessDate, executor),
        absentOn(actor, houseId, occurrence.date as BusinessDate, executor),
      ]);

      absentByDate.set(occurrence.date, absent);
      occupantsByDate.set(
        occurrence.date,
        new Map(occupants.map((row) => [row.bedId, row.userId])),
      );
    }

    /*
     * Место позиции берётся из версии состава, действующей на дату занятия:
     * состав мог смениться позже, и прошлую неделю это не касается (§2.2).
     */
    const roster = effectiveVersion(rostersByRow.get(rowId) ?? [], occurrence.date as BusinessDate);
    const occupants = occupantsByDate.get(occurrence.date);

    for (const assignment of assignments.filter((item) => item.occurrenceId === occurrence.id)) {
      if (assignment.source !== 'auto') {
        continue;
      }

      if (assignment.state !== 'assigned' && assignment.state !== 'needs_reassignment') {
        continue;
      }

      const bedId = roster?.bedIds[assignment.slotPosition ?? -1] ?? '';
      const living = occupants?.get(bedId) ?? null;
      const absent = absentByDate.get(occurrence.date);
      const userId =
        living !== null && freedByAbsence(occurrence.type) && absent?.has(living) === true
          ? null
          : living;

      if (userId === assignment.userId) {
        continue;
      }

      await updateAssignment(
        assignment.id,
        {
          userId,
          state: userId === null ? 'needs_reassignment' : 'assigned',
          emptyReason: living === null ? 'empty_bed' : 'absent',
        },
        executor,
      );

      changed += 1;
    }
  }

  return changed;
}
