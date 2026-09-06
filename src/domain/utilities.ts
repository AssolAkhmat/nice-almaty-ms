import {
  addDays,
  compareBusinessDates,
  daysInMonth,
  businessDate,
  businessDateToParts,
  differenceInDays,
  endOfMonth,
  startOfMonth,
  type BusinessDate,
} from '@/lib/time';

import { splitCeil } from './money';

/**
 * Коммунальные услуги (docs/03-BUSINESS-RULES.md §4).
 * Чистые функции: ни БД, ни часов. Все примеры §4.1–4.3 — в тестах.
 */
export interface LivedRange {
  /** Первое число месяца, за который считается коммуналка. */
  month: BusinessDate;
  moveIn: BusinessDate | null;
  /** Пусто — проживание продолжается. */
  moveOut: BusinessDate | null;
}

/** Отрезок долгосрочного отсутствия: день отъезда и день возвращения (§4.2). */
export interface AbsenceRange {
  from: BusinessDate;
  to: BusinessDate;
}

export interface UtilityParticipant {
  userId: string;
  /** Дни проживания за вычетом дней отсутствия. */
  days: number;
}

export interface UtilityAllocation {
  userId: string;
  days: number;
  amount: number;
}

export interface UtilityDistribution {
  allocations: UtilityAllocation[];
  /** Излишек округления — в фонд дома (§0). */
  surplus: number;
  /** Сумма, которую не на кого делить: в доме за месяц не жил никто. */
  undistributed: number;
}

function lastDayOfMonth(month: BusinessDate): BusinessDate {
  return endOfMonth(month);
}

/**
 * Сколько дней месяца человек прожил. День заезда и день выезда считаются
 * прожитыми (§4.2) — в отличие от периода занятости места, где день выезда
 * уже свободен: там речь про место, здесь про человека.
 */
export function daysLivedInMonth(range: LivedRange): number {
  if (range.moveIn === null) {
    return 0;
  }

  const first = startOfMonth(range.month);
  const last = lastDayOfMonth(range.month);

  const start = compareBusinessDates(range.moveIn, first) > 0 ? range.moveIn : first;
  const end =
    range.moveOut !== null && compareBusinessDates(range.moveOut, last) < 0 ? range.moveOut : last;

  if (compareBusinessDates(start, end) > 0) {
    return 0;
  }

  return differenceInDays(start, end) + 1;
}

/**
 * Дни, которые вычитаются из проживания за долгосрочное отсутствие.
 * День отъезда и день возвращения считаются прожитыми, не считаются только
 * дни строго между ними (§4.2, пример 4.3).
 */
export function absentDaysInMonth(month: BusinessDate, absences: readonly AbsenceRange[]): number {
  const first = startOfMonth(month);
  const last = lastDayOfMonth(month);

  let total = 0;

  for (const absence of absences) {
    const from = addDays(absence.from, 1);
    const to = addDays(absence.to, -1);

    if (compareBusinessDates(from, to) > 0) {
      continue;
    }

    const start = compareBusinessDates(from, first) > 0 ? from : first;
    const end = compareBusinessDates(to, last) < 0 ? to : last;

    if (compareBusinessDates(start, end) <= 0) {
      total += differenceInDays(start, end) + 1;
    }
  }

  return total;
}

/** Число дней в месяце — по календарю Алматы, без переходов на летнее время. */
export function daysInBusinessMonth(month: BusinessDate): number {
  const { year, month: index } = businessDateToParts(month);

  return daysInMonth(year, index);
}

/** Первое число месяца, к которому относится дата. */
export function monthOf(date: BusinessDate): BusinessDate {
  const { year, month } = businessDateToParts(date);

  return businessDate(year, month, 1);
}

/**
 * Распределение суммы периода между жильцами пропорционально дням (§4.2).
 * Тот, кто не прожил в месяце ни дня, в распределении не участвует —
 * иначе он получил бы долю за чужой месяц.
 */
export function distributeUtilities(
  total: number,
  participants: readonly UtilityParticipant[],
): UtilityDistribution {
  const paying = participants.filter((participant) => participant.days > 0);

  if (paying.length === 0) {
    // Делить не на кого: сумма остаётся дому целиком, а не делится на ноль.
    return { allocations: [], surplus: 0, undistributed: total };
  }

  const { shares, surplus } = splitCeil(
    total,
    paying.map((participant) => participant.days),
  );

  return {
    allocations: paying.map((participant, index) => ({
      userId: participant.userId,
      days: participant.days,
      amount: shares[index] ?? 0,
    })),
    surplus,
    undistributed: 0,
  };
}
