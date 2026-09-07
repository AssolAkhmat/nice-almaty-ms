import { getDb, type Executor } from '@/db/client';
import {
  listAssignmentsFor,
  listCalendarDictionaries,
  listOccurrences,
} from '@/db/repositories/rotations';
import {
  summarizeByArea,
  summarizeByPerson,
  summarizeByWeekday,
  summarizeMonths,
  type AreaSummary,
  type MonthSummary,
  type PersonSummary,
  type StatsRecord,
  type WeekdaySummary,
} from '@/domain/rotation-stats';
import { assertCan } from '@/lib/authz';
import { type BusinessDate } from '@/lib/time';

import type { UserActor } from './users';

/**
 * Статистика ротаций (docs/04-MODULES/04-rotation-scoring.md).
 *
 * Читается правом на оценку, а не на чтение календаря: средняя оценка —
 * это и есть оценки, а их §7 показывает только админу и суперадмину.
 * Экспорт CSV/XLSX — фаза 6.
 */
export interface StatsDeps {
  executor?: Executor;
}

export interface RotationStatsView {
  byPerson: (PersonSummary & { name: string })[];
  months: MonthSummary[];
  byArea: (AreaSummary & { name: string })[];
  byWeekday: WeekdaySummary[];
  /** Сколько состоявшихся назначений вошло в свод. */
  total: number;
}

export async function readRotationStats(
  actor: UserActor,
  houseId: string,
  range: { from: BusinessDate; to: BusinessDate },
  deps: StatsDeps = {},
): Promise<RotationStatsView> {
  const executor = deps.executor ?? getDb();

  assertCan(actor.context, 'rotation.score', { houseId });

  const occurrences = await listOccurrences(actor.context, houseId, range, executor);
  const [assignments, dictionaries] = await Promise.all([
    listAssignmentsFor(
      occurrences.map((occurrence) => occurrence.id),
      executor,
    ),
    listCalendarDictionaries(actor.context, houseId, executor),
  ]);

  const byOccurrence = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));

  const records: StatsRecord[] = assignments.flatMap((assignment) => {
    const occurrence = byOccurrence.get(assignment.occurrenceId);

    if (occurrence === undefined) {
      return [];
    }

    return [
      {
        userId: assignment.userId,
        areaId: occurrence.areaId,
        date: occurrence.date as BusinessDate,
        // Отменённое занятие отменяет и свои назначения, но статус занятия
        // надёжнее: он один на всю уборку.
        state: occurrence.status === 'cancelled' ? ('cancelled' as const) : assignment.state,
        score: assignment.score,
      },
    ];
  });

  const names = new Map(dictionaries.members.map((member) => [member.userId, member.name]));
  const areas = new Map(dictionaries.areas.map((area) => [area.id, area.name]));

  return {
    byPerson: summarizeByPerson(records).map((person) => ({
      ...person,
      name: names.get(person.userId) ?? '—',
    })),
    months: summarizeMonths(records),
    byArea: summarizeByArea(records).map((area) => ({
      ...area,
      name: areas.get(area.areaId) ?? '—',
    })),
    byWeekday: summarizeByWeekday(records),
    total: records.filter((record) => record.state === 'confirmed' || record.state === 'missed')
      .length,
  };
}
