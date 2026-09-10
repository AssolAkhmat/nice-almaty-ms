import { getDb, type Executor } from '@/db/client';
import { listBedOccupantsOn, listRotationDebts, listRowRosters } from '@/db/repositories/rotations';
import {
  effectiveVersion,
  resolutionCandidates,
  swapOptions,
  type CandidateSource,
  type DayPlanShape,
  type EmptySlotReason,
  type ResolutionCandidate,
  type RosterVersion,
} from '@/domain/rotation-day';
import { debtBalance } from '@/domain/rotation-debt';
import { addDays, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { readCalendar } from './rotation-calendar';
import { absentOn, eligibilityOfHouse } from './rotation-schedule';

import type { UserActor } from './users';

/**
 * «Требует решения»: дырки расписания с причиной и вариантами
 * (`docs/tasks/PHASE-10.md` §2.5, §2.8; docs/03-BUSINESS-RULES.md §6.3).
 *
 * Система предлагает, админ решает. Варианты считаются при чтении по
 * материализованным занятиям дня и ничего не сохраняют: выбор админа —
 * обычная правка недели через календарь (`placeOnOccurrence`,
 * `swapAssignments`, `cancelOccurrence`).
 */
export interface DecisionsDeps {
  executor?: Executor;
  today?: BusinessDate;
}

/** Сколько дней вперёд показывать дырки: неделя — один проход каждого ряда. */
export const DECISION_HORIZON_DAYS = 7;

export interface DecisionCandidate {
  userId: string;
  name: string;
  source: CandidateSource;
  /** Пускает ли группа допуска к зоне (§6.1); недопущенный показан с пометкой. */
  eligible: boolean;
  /** Зоны, которые он уже убирает в этот день. */
  busyAreaNames: string[];
  /** Баланс книги долга; должником делает только положительный (§2.7). */
  debt: number;
}

/** Обмен в один ход: перевести человека с его зоны на дырку, на его зону — кандидата. */
export interface DecisionSwap {
  moverAssignmentId: string;
  userId: string;
  name: string;
  fromAreaId: string;
  fromAreaName: string;
  replacements: DecisionCandidate[];
}

export interface HoleDecision {
  assignmentId: string;
  occurrenceId: string;
  date: BusinessDate;
  areaId: string;
  areaName: string;
  checklistTitle: string;
  reason: EmptySlotReason;
  /** Кто стоял в очереди, но не допущен: «по очереди — Азамат, не допущен». */
  queuedName: string | null;
  candidates: DecisionCandidate[];
  swaps: DecisionSwap[];
}

interface DayAssignment {
  assignmentId: string;
  userId: string | null;
  areaId: string;
  state: string;
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Дырки дома на ближайшую неделю с причиной, кандидатами и обменами.
 *
 * Вчерашний день входит: до 23:55 его ещё можно закрыть (§7). План дня
 * собирается из занятий, а не пересчитывается по сетке: варианты обязаны
 * видеть ручные правки недели, иначе предлагали бы уже занятого.
 * «Отдыхающие в этот день» — жильцы составов рядов этого дня без назначения;
 * жильцы вне составов идут последними (§6.3).
 */
export async function readHoleDecisions(
  actor: UserActor,
  houseId: string,
  deps: DecisionsDeps = {},
): Promise<HoleDecision[]> {
  const executor = deps.executor ?? getDb();
  const today = deps.today ?? todayInAlmaty();

  const calendar = await readCalendar(
    actor,
    { from: addDays(today, -1), to: addDays(today, DECISION_HORIZON_DAYS) },
    { executor, houseId },
  );

  const scheduled = calendar.occurrences.filter((item) => item.occurrence.status === 'scheduled');
  const holes = scheduled.flatMap((item) =>
    item.assignments
      .filter(
        (assignment) => assignment.userId === null && assignment.state === 'needs_reassignment',
      )
      .map((assignment) => ({ item, assignment })),
  );

  if (holes.length === 0) {
    return [];
  }

  const areas = new Map(calendar.dictionaries.areas.map((area) => [area.id, area.name]));
  const checklists = new Map(
    calendar.dictionaries.checklists.map((checklist) => [checklist.id, checklist.title]),
  );
  const names = new Map(
    calendar.dictionaries.members.map((member) => [member.userId, member.name]),
  );
  const residentUserIds = calendar.dictionaries.members.map((member) => member.userId);

  const [eligibleByArea, debts] = await Promise.all([
    eligibilityOfHouse(actor, houseId, executor),
    listRotationDebts(actor.context, { userIds: residentUserIds, on: today }, executor),
  ]);

  const debtBalances: Record<string, number> = {};

  for (const userId of residentUserIds) {
    debtBalances[userId] = debtBalance(debts.filter((debt) => debt.userId === userId));
  }

  const toCandidate = (candidate: ResolutionCandidate): DecisionCandidate => ({
    userId: candidate.userId,
    name: names.get(candidate.userId) ?? '',
    source: candidate.source,
    eligible: candidate.eligible,
    busyAreaNames: candidate.busyAreaIds.map((areaId) => areas.get(areaId) ?? ''),
    debt: debtBalances[candidate.userId] ?? 0,
  });

  const rostersByRow = new Map<string, RosterVersion[]>();
  const result: HoleDecision[] = [];
  const dates = [...new Set(holes.map((hole) => hole.item.occurrence.date))].sort();

  for (const date of dates) {
    const businessDate = date as BusinessDate;
    const ofDate = scheduled.filter((item) => item.occurrence.date === date);

    const [absent, occupants] = await Promise.all([
      absentOn(actor, houseId, businessDate, executor),
      listBedOccupantsOn(actor.context, houseId, businessDate, executor),
    ]);
    const occupantOfBed = new Map(occupants.map((row) => [row.bedId, row.userId]));

    const assignmentsOfDay: DayAssignment[] = ofDate.flatMap((item) =>
      item.assignments
        .filter((assignment) => assignment.state !== 'cancelled')
        .map((assignment) => ({
          assignmentId: assignment.id,
          userId: assignment.userId,
          areaId: item.occurrence.areaId,
          state: assignment.state,
        })),
    );
    const assignedToday = new Set(assignmentsOfDay.map((entry) => entry.userId).filter(nonNull));

    const resting: { userId: string | null }[] = [];
    const rowIds = [...new Set(ofDate.map((item) => item.occurrence.rowId).filter(nonNull))];

    for (const rowId of rowIds) {
      if (!rostersByRow.has(rowId)) {
        rostersByRow.set(rowId, await listRowRosters(actor.context, rowId, executor));
      }

      const roster = effectiveVersion(rostersByRow.get(rowId) ?? [], businessDate);

      for (const bedId of roster?.bedIds ?? []) {
        const userId = occupantOfBed.get(bedId) ?? null;

        if (userId !== null && !assignedToday.has(userId)) {
          resting.push({ userId });
        }
      }
    }

    const plan: DayPlanShape = { assignments: assignmentsOfDay, resting };

    for (const { item, assignment } of holes.filter((hole) => hole.item.occurrence.date === date)) {
      const areaId = item.occurrence.areaId;
      const input = {
        areaId,
        plan,
        residentUserIds,
        debtBalances,
        absentUserIds: [...absent],
        eligibleByArea,
      };

      // Кто уже стоит на этой же зоне в этот день, второй раз на неё не встанет.
      const candidates = resolutionCandidates(input)
        .filter((candidate) => !candidate.busyAreaIds.includes(areaId))
        .map(toCandidate);

      const swaps: DecisionSwap[] = [];

      for (const option of swapOptions(input)) {
        const mover = assignmentsOfDay.find(
          (entry) => entry.userId === option.userId && entry.areaId === option.fromAreaId,
        );

        // Переводят только незакрытое назначение: подтверждённое — уже история.
        if (mover === undefined || mover.state !== 'assigned') {
          continue;
        }

        swaps.push({
          moverAssignmentId: mover.assignmentId,
          userId: option.userId,
          name: names.get(option.userId) ?? '',
          fromAreaId: option.fromAreaId,
          fromAreaName: areas.get(option.fromAreaId) ?? '',
          replacements: option.replacements
            .filter((candidate) => !candidate.busyAreaIds.includes(option.fromAreaId))
            .map(toCandidate),
        });
      }

      result.push({
        assignmentId: assignment.id,
        occurrenceId: item.occurrence.id,
        date: businessDate,
        areaId,
        areaName: areas.get(areaId) ?? '',
        checklistTitle: checklists.get(item.occurrence.checklistId) ?? '',
        reason: assignment.emptyReason ?? 'no_one',
        queuedName:
          assignment.queuedUserId === null ? null : (names.get(assignment.queuedUserId) ?? null),
        candidates,
        swaps,
      });
    }
  }

  return result;
}
