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
  /** Доля дома: человеко-дни Исполнителя и его сумма (P2-7). */
  house: { days: number; amount: number };
}

function lastDayOfMonth(month: BusinessDate): BusinessDate {
  return endOfMonth(month);
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
/**
 * Месяц, на котором открывается экран периода (находка P2-8, 27 сентября 2026).
 *
 * Текущий месяц в зоне сети, и никакого сдвига. Раньше здесь стоял «прошлый
 * месяц»: в сентябре экран открывался на августе, и админ каждый раз искал
 * сентябрь руками. Сдвиг казался удобным — коммуналку закрывают за прошедший
 * месяц, — но он ломал первое, зачем на экран заходят: завести текущий период.
 */
export function defaultUtilityMonth(today: BusinessDate): BusinessDate {
  return monthOf(today);
}

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

/**
 * Ручная корректировка человеко-дней (находка P2-6, 27 сентября 2026).
 *
 * Формула §4.2 знает только даты заселения и одобренные отъезды. В январе
 * жильцы разъезжаются на каникулы, не оформляя отсутствие, а отопление
 * горит — расчёт по календарю оказывается справедливым только на бумаге.
 * Поэтому число суток админ вправе поставить своё.
 *
 * Направления неравноправны, и это главное в правиле:
 *
 * - **меньше расчётного** — свободно: начисление выходит меньше договорного,
 *   а меньше договорного можно всегда (п. 4.5 Договора);
 * - **больше расчётного** — только с отдельным подтверждением: формула
 *   договора столько суток не даёт, и одним движением поля это не делается.
 *
 * Потолок — число суток в месяце: тридцать первое сентября не наступает
 * ни при какой корректировке.
 */
export type DayCorrectionProblem = 'daysInvalid' | 'commentRequired' | 'increaseNotConfirmed';

export interface DayCorrectionInput {
  month: BusinessDate;
  /** Что посчитала система. */
  systemDays: number;
  /** Что ставит администратор. */
  days: number;
  comment: string;
  /** Явно подтверждённое увеличение выше расчётного. */
  confirmIncrease: boolean;
}

export function checkDayCorrection(input: DayCorrectionInput): DayCorrectionProblem | null {
  if (
    !Number.isSafeInteger(input.days) ||
    input.days < 0 ||
    input.days > daysInBusinessMonth(input.month)
  ) {
    return 'daysInvalid';
  }

  if (input.comment.trim() === '') {
    return 'commentRequired';
  }

  if (input.days > input.systemDays && !input.confirmIncrease) {
    return 'increaseNotConfirmed';
  }

  return null;
}

/** Отрезок занятости места внутри месяца: полуоткрытый, как в базе. */
export interface StayRange {
  from: BusinessDate;
  /** Пусто — занятость продолжается. */
  to: BusinessDate | null;
}

export interface HouseOccupancyInput {
  /** Первое число месяца, за который считается коммуналка. */
  month: BusinessDate;
  /** Отрезки занятости мест ЭТОГО дома, полуоткрытые `[from, to)`, как в базе. */
  stays: readonly StayRange[];
  /**
   * Дата выезда из сети, если она есть. Нужна ровно для одного правила §4.2 —
   * «день выезда считается прожитым», — и ни для чего больше: участие
   * в раскладке она не решает.
   */
  moveOut?: BusinessDate | null | undefined;
}

/**
 * Сколько суток месяца человек занимал место ИМЕННО В ЭТОМ ДОМЕ.
 *
 * Участие в раскладке и число суток определяет занятость койко-места,
 * а не роль пользователя и не дата заселения проживания (указание владельца,
 * 30 сентября 2026). Роль и занятость места ортогональны: админ дома с местом
 * платит коммуналку наравне со всеми, а жилец без места не платит, какой бы
 * у него ни был статус.
 *
 * До 30 сентября сутки брались из `residencies.move_in_date`, и это было
 * неверно дважды. У админа дома и у части жильцов даты заселения нет вовсе
 * (статус `created`) — они выпадали из знаменателя, и их потребление
 * раскладывалось на остальных. У многих дата заселения оказалась позже начала
 * занятости места — сентябрь считался с 25-го числа вместо всего месяца.
 * На боевой базе это давало знаменатель 75 человеко-суток вместо 428.
 *
 * Сутки складываются по дням, а не по длинам отрезков: отрезков у человека
 * в месяце бывает несколько (переселение внутри дома), и один день не должен
 * попасть в сумму дважды.
 *
 * Отрезок полуоткрыт: день, которым отрезок закрыт, месту уже не принадлежит —
 * в этот день человек либо на новом месте, либо уехал. Поэтому «день выезда
 * прожит» (§4.2) добавляется отдельно и только для настоящего выезда из сети:
 * иначе день переезда достался бы двум домам сразу.
 */
export function occupiedDaysInMonth(input: HouseOccupancyInput): number {
  const first = startOfMonth(input.month);
  const last = lastDayOfMonth(input.month);

  const leavesHere =
    input.moveOut !== null &&
    input.moveOut !== undefined &&
    input.stays.some((stay) => stay.to !== null && stay.to === input.moveOut);

  let days = 0;

  for (let day = first; compareBusinessDates(day, last) <= 0; day = addDays(day, 1)) {
    const occupied = input.stays.some(
      (stay) =>
        compareBusinessDates(stay.from, day) <= 0 &&
        (stay.to === null || compareBusinessDates(day, stay.to) < 0),
    );

    if (occupied || (leavesHere && day === input.moveOut)) {
      days += 1;
    }
  }

  return days;
}

/**
 * Распределение суммы периода между жильцами пропорционально дням (§4.2).
 * Тот, кто не прожил в месяце ни дня, в распределении не участвует —
 * иначе он получил бы долю за чужой месяц.
 *
 * `houseDays` — доля дома в человеко-днях (P2-7, указание владельца
 * 27 сентября 2026). Общие помещения греются независимо от заселённости,
 * пустые места тоже потребляют, и эту часть платит Исполнитель. Дом входит
 * в знаменатель ровно так же, как жилец: одни человеко-сутки дома равны
 * одним человеко-суткам жильца, заехавшего на день.
 *
 * Направление от этого строго одно. Знаменатель растёт, доля каждого
 * жильца — `ceil(total * days / totalDays)` — от роста знаменателя может
 * только уменьшиться или остаться прежней. Увеличить чью-то долю доля дома
 * не способна ни при каком значении, и это свойство проверяется перебором,
 * а не рассуждением.
 */
export function distributeUtilities(
  total: number,
  participants: readonly UtilityParticipant[],
  houseDays = 0,
): UtilityDistribution {
  if (!Number.isSafeInteger(houseDays) || houseDays < 0) {
    throw new RangeError(
      `Доля дома — целое неотрицательное число человеко-дней, получено: ${String(houseDays)}`,
    );
  }

  const paying = participants.filter((participant) => participant.days > 0);

  if (paying.length === 0) {
    /*
     * Делить не на кого. Если у дома заявлены сутки — вся сумма его:
     * месяц, в котором никто не жил, целиком оплачивает Исполнитель,
     * и это осмысленный итог, а не потерянная сумма. Если суток нет —
     * сумма остаётся неразнесённой, и закрытие периода об этом скажет.
     */
    return houseDays > 0
      ? { allocations: [], surplus: 0, undistributed: 0, house: { days: houseDays, amount: total } }
      : { allocations: [], surplus: 0, undistributed: total, house: { days: 0, amount: 0 } };
  }

  const weights = paying.map((participant) => participant.days);
  const { shares, surplus } = splitCeil(total, houseDays > 0 ? [...weights, houseDays] : weights);

  return {
    allocations: paying.map((participant, index) => ({
      userId: participant.userId,
      days: participant.days,
      amount: shares[index] ?? 0,
    })),
    surplus,
    undistributed: 0,
    house: { days: houseDays, amount: houseDays > 0 ? (shares[weights.length] ?? 0) : 0 },
  };
}
