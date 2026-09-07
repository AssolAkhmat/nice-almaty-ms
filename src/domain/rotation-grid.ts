import { differenceInDays, type BusinessDate } from '@/lib/time';

/**
 * Сетка ротаций (docs/03-BUSINESS-RULES.md §6.2).
 *
 * ```
 * duties = зоны ряда, каждая повторена people_needed раз   -> длина D
 * slots  = места ряда                                       -> длина S
 * требование: D <= S                                        (инвариант 9)
 * vector = duties ++ [ОТДЫХ] * (S - D)                      -> длина S
 * k      = floor( (дата - дата первой ротации ряда) / 7 )   -> номер недели, с 0
 * assignment(i, k) = vector[ (i + k) mod S ]
 * ```
 *
 * Чистые функции: ни БД, ни часов, ни истории исполнения. Сетка детерминирована —
 * отменённые и перенесённые занятия всё равно увеличивают `k`, потому что `k`
 * считается от календарной даты, а не от числа проведённых ротаций.
 *
 * Слот здесь — только номер позиции в ряду. Кто именно за ним стоит,
 * решает уже расписание: слот привязан к месту, а не к человеку (§6.1).
 */

/** Зона ряда вместе с чек-листом, по которому её убирают. */
export interface RotationRowZone {
  areaId: string;
  checklistId: string;
  /** Сколько человек требует чек-лист зоны: столько слотов она и занимает. */
  peopleNeeded: number;
}

/** Что достаётся слоту на неделе: зона с чек-листом или отдых. */
export type RotationDuty =
  | { readonly kind: 'zone'; readonly areaId: string; readonly checklistId: string }
  | { readonly kind: 'rest' };

const DAYS_IN_WEEK = 7;

/**
 * Раскладывает зоны ряда по слотам и добивает остаток отдыхом.
 * Нарушение `D <= S` — ошибка, а не молчаливое усечение: иначе зона,
 * не поместившаяся в ряд, просто перестала бы убираться.
 */
export function rotationVector(
  zones: readonly RotationRowZone[],
  slotCount: number,
): RotationDuty[] {
  if (!Number.isInteger(slotCount) || slotCount < 1) {
    throw new RangeError(
      `В ряду ротаций должно быть хотя бы одно место, задано: ${String(slotCount)}`,
    );
  }

  const duties: RotationDuty[] = [];

  for (const zone of zones) {
    if (!Number.isInteger(zone.peopleNeeded) || zone.peopleNeeded < 1) {
      throw new RangeError(
        `people_needed зоны ${zone.areaId} должно быть целым числом от единицы, задано: ${String(zone.peopleNeeded)}`,
      );
    }

    for (let repeat = 0; repeat < zone.peopleNeeded; repeat += 1) {
      duties.push({ kind: 'zone', areaId: zone.areaId, checklistId: zone.checklistId });
    }
  }

  if (duties.length > slotCount) {
    throw new RangeError(
      `Инвариант 9 нарушен: обязанностей (${duties.length}) больше, чем слотов (${slotCount})`,
    );
  }

  while (duties.length < slotCount) {
    duties.push({ kind: 'rest' });
  }

  return duties;
}

/**
 * Номер недели ряда по дате занятия, с нуля.
 *
 * Дробная часть отбрасывается: занятие, перенесённое со вторника на четверг,
 * остаётся в своей неделе. Дата раньше первой ротации ряда — ошибка:
 * сетка до старта ряда не определена, и молчаливый отрицательный `k`
 * дал бы правдоподобные, но выдуманные назначения.
 */
export function weekIndex(rowStartDate: BusinessDate, date: BusinessDate): number {
  const days = differenceInDays(rowStartDate, date);

  if (days < 0) {
    throw new RangeError(`Дата ${date} раньше первой ротации ряда (${rowStartDate})`);
  }

  return Math.floor(days / DAYS_IN_WEEK);
}

/** Обязанность слота `i` на неделе `k`: `vector[(i + k) mod S]`. */
export function assignmentAt(
  vector: readonly RotationDuty[],
  slotIndex: number,
  week: number,
): RotationDuty {
  if (!Number.isInteger(week) || week < 0) {
    throw new RangeError(`Номер недели ряда не может быть таким: ${String(week)}`);
  }

  // Границы проверяются до приведения по модулю: слот 6 в ряду из шести мест
  // иначе молча стал бы слотом 0 и вернул чужую зону.
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= vector.length) {
    throw new RangeError(
      `В ряду нет слота с номером ${String(slotIndex)}: мест всего ${vector.length}`,
    );
  }

  const duty = vector[(slotIndex + week) % vector.length];

  if (duty === undefined) {
    throw new RangeError(`В ряду нет слота с номером ${String(slotIndex)}`);
  }

  return duty;
}

/** Обязанности всех слотов ряда на неделе `k`, по порядку позиций. */
export function weekAssignments(vector: readonly RotationDuty[], week: number): RotationDuty[] {
  return vector.map((_, slotIndex) => assignmentAt(vector, slotIndex, week));
}
