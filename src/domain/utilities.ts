import {
  addDays,
  addMonths,
  compareBusinessDates,
  daysInMonth,
  businessDate,
  businessDateToParts,
  differenceInDays,
  endOfMonth,
  startOfMonth,
  tryParseBusinessDate,
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
 * Месяц из строки экрана: `2026-09` от `<input type="month">` либо полная
 * дата из ссылки. Возвращает первое число месяца или `null`, если строка
 * месяцем не является.
 *
 * Нужна оттого, что месяц периода приходит с экрана двумя видами: поле
 * выбора месяца в браузере отдаёт `ГГГГ-ММ`, а ссылки переключателя несут
 * полную дату. Разбирать их в двух местах по-разному — значит однажды
 * разобрать по-разному.
 */
export function parseMonthInput(value: string): BusinessDate | null {
  const trimmed = value.trim();
  const withDay = /^\d{4}-\d{2}$/.test(trimmed) ? `${trimmed}-01` : trimmed;
  const parsed = tryParseBusinessDate(withDay);

  return parsed === null ? null : monthOf(parsed);
}

/**
 * Месяцы переключателя на экране коммуналки: текущий, прошлый и все, по
 * которым период уже заведён, от нового к старому.
 *
 * Текущий месяц входит всегда — на этом экран и сломался: список считался
 * как «прошлый и два до него», поэтому 22 сентября в нём не было самого
 * сентября, и завести период за текущий месяц было нечем (указание
 * владельца, 22 сентября 2026). Правило закреплено тестом, а не намерением.
 */
export function monthOptions(
  thisMonth: BusinessDate,
  existing: readonly BusinessDate[],
): BusinessDate[] {
  const months = new Set<BusinessDate>([monthOf(thisMonth), addMonths(monthOf(thisMonth), -1)]);

  for (const month of existing) {
    months.add(monthOf(month));
  }

  return [...months].sort().reverse();
}

/** Отрезок занятости места внутри месяца: полуоткрытый, как в базе. */
export interface StayRange {
  from: BusinessDate;
  /** Пусто — занятость продолжается. */
  to: BusinessDate | null;
}

export interface HouseDaysInput extends LivedRange {
  /** Отрезки занятости мест ЭТОГО дома внутри месяца. */
  stays: readonly StayRange[];
  /** В этом же месяце у жильца было место и в другом доме. */
  elsewhere: boolean;
  /** Проживание числится за этим домом сейчас. */
  belongsNow: boolean;
}

/**
 * Сколько дней месяца человек прожил ИМЕННО В ЭТОМ ДОМЕ (§4.2 с поправкой
 * на переселение, решение D26).
 *
 * Дни проживания глобальны для проживания: заезд и выезд дому не принадлежат.
 * Пока человек весь месяц в одном доме, этого достаточно — и тогда функция
 * отвечает ровно то же, что отвечала прежняя `daysLivedInMonth`. Разница
 * появляется в двух случаях, и оба раньше считались неверно:
 *
 * 1. Месяц переселения. Старый расчёт давал полный месяц дней **обоим**
 *    домам: человек платил бы дважды, каждому дому за все тридцать дней.
 * 2. Прошлый месяц, пересчитанный после переселения. Старый расчёт брал
 *    «дом сейчас» и переносил август в новый дом, где человека в августе
 *    не было вовсе.
 *
 * Поэтому когда месяц чистый (`elsewhere === false`), дни отдаются целиком
 * тому дому, за которым человек числится или где стоял на месте. Когда
 * в месяце есть оба дома — дни режутся по отрезкам занятости.
 */
export function daysLivedInHouseInMonth(input: HouseDaysInput): number {
  const lived = daysLivedInMonth(input);

  if (lived === 0) {
    return 0;
  }

  if (!input.elsewhere) {
    return input.belongsNow || input.stays.length > 0 ? lived : 0;
  }

  const first = startOfMonth(input.month);
  const last = lastDayOfMonth(input.month);

  const start =
    input.moveIn !== null && compareBusinessDates(input.moveIn, first) > 0 ? input.moveIn : first;
  const end =
    input.moveOut !== null && compareBusinessDates(input.moveOut, last) < 0 ? input.moveOut : last;

  let days = 0;

  for (let day = start; compareBusinessDates(day, end) <= 0; day = addDays(day, 1)) {
    const inside = input.stays.some(
      (stay) =>
        compareBusinessDates(stay.from, day) <= 0 &&
        (stay.to === null || compareBusinessDates(day, stay.to) < 0),
    );

    if (inside) {
      days += 1;
    }
  }

  return days;
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
