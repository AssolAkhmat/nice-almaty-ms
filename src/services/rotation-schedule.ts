import { getDb, type Executor } from '@/db/client';
import { listApprovedAbsences } from '@/db/repositories/rating';
import {
  createAssignment,
  createOccurrence,
  listAssignmentsFor,
  listBedOccupantsOn,
  listOccurrences,
  listRotationRows,
  listRowSlots,
  listRowZones,
  updateAssignment,
} from '@/db/repositories/rotations';
import { assignmentAt, rotationVector, weekIndex } from '@/domain/rotation-grid';
import { assertCan } from '@/lib/authz';
import {
  addDays,
  compareBusinessDates,
  differenceInDays,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import type { RotationAssignment, RotationOccurrence } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Материализация расписания ротаций (docs/03-BUSINESS-RULES.md §6.2, §6.3, §6.6).
 *
 * Расписание живёт в базе занятиями, а не считается на лету: занятие можно
 * перенести, отменить и переназначить. Сетка при этом остаётся формулой —
 * `src/domain/rotation-grid.ts`, — и генерация только раскладывает её
 * по календарю и по нынешним жильцам мест.
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
async function absentOn(
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
    const [slots, zones] = await Promise.all([
      listRowSlots(actor.context, row.id, executor),
      listRowZones(actor.context, row.id, executor),
    ]);

    if (slots.length === 0 || zones.length === 0) {
      continue;
    }

    const vector = rotationVector(zones, slots.length);
    const dates = rowDates(row.startDate as BusinessDate, today, until);

    for (const date of dates) {
      const week = weekIndex(row.startDate as BusinessDate, date);

      // Кто где живёт — на дату занятия, а не на день генерации: место может
      // освободиться между ними, и тогда назначение сразу ждёт решения админа.
      const occupants = new Map(
        (await listBedOccupantsOn(actor.context, houseId, date, executor)).map((row) => [
          row.bedId,
          row.userId,
        ]),
      );

      const absent = await absentOn(actor, houseId, date, executor);

      /** Слоты, которым на этой неделе выпала зона: ключ — зона с чек-листом. */
      const byZone = new Map<string, { areaId: string; checklistId: string; slots: number[] }>();

      slots.forEach((slot, index) => {
        const duty = assignmentAt(vector, index, week);
        if (duty.kind === 'rest') {
          return;
        }

        const key = `${duty.areaId}|${duty.checklistId}`;
        const group = byZone.get(key) ?? {
          areaId: duty.areaId,
          checklistId: duty.checklistId,
          slots: [],
        };
        group.slots.push(slot.position);
        byZone.set(key, group);
      });

      const existing = await listOccurrences(
        actor.context,
        houseId,
        { from: date, to: date },
        executor,
      );

      for (const group of byZone.values()) {
        const already = existing.find(
          (occurrence) => occurrence.rowId === row.id && occurrence.areaId === group.areaId,
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
            areaId: group.areaId,
            checklistId: group.checklistId,
            date,
            type: row.type === 'room' ? 'room' : 'regular',
            cycleIndex: week,
          },
          executor,
        );

        created += 1;

        for (const position of group.slots) {
          const bedId = slots.find((slot) => slot.position === position)?.bedId ?? '';
          const living = occupants.get(bedId) ?? null;
          /*
           * Отсутствующий на эту дату общую зону не убирает: назначение
           * достаётся не ему, а задаче админа «отмени или назначь вручную».
           */
          const occurrenceType = row.type === 'room' ? 'room' : 'regular';
          const userId =
            living !== null && freedByAbsence(occurrenceType) && absent.has(living) ? null : living;

          await createAssignment(
            actor.context,
            {
              occurrenceId: occurrence.id,
              userId,
              slotPosition: position,
              source: 'auto',
              // Пустующее место не исчезает из расписания: админ видит задачу
              // «отмени или назначь вручную» (§6.3), а не молчаливую дыру.
              state: userId === null ? 'needs_reassignment' : 'assigned',
            },
            executor,
          );
        }
      }
    }
  }

  return { created };
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

  const slotsByRow = new Map<string, Map<number, string>>();
  const occupantsByDate = new Map<string, Map<string, string>>();
  const absentByDate = new Map<string, Set<string>>();
  let changed = 0;

  for (const occurrence of scheduled) {
    const rowId = occurrence.rowId ?? '';

    if (!slotsByRow.has(rowId)) {
      const slots = await listRowSlots(actor.context, rowId, executor);
      slotsByRow.set(rowId, new Map(slots.map((slot) => [slot.position, slot.bedId])));
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

    const slots = slotsByRow.get(rowId);
    const occupants = occupantsByDate.get(occurrence.date);

    for (const assignment of assignments.filter((item) => item.occurrenceId === occurrence.id)) {
      if (assignment.source !== 'auto') {
        continue;
      }

      if (assignment.state !== 'assigned' && assignment.state !== 'needs_reassignment') {
        continue;
      }

      const bedId = slots?.get(assignment.slotPosition ?? -1) ?? '';
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
        },
        executor,
      );

      changed += 1;
    }
  }

  return changed;
}
