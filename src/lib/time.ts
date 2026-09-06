/**
 * Единственная точка работы со временем (docs/03-BUSINESS-RULES.md §0).
 *
 * Зона расчётов — Asia/Almaty, UTC+5 без переходов на летнее время.
 * Календарные сутки — [00:00, 24:00) местного времени.
 * Прямой `new Date()` разрешён только в этом файле; правило ESLint запрещает его везде ещё.
 */

export const ALMATY_TIME_ZONE = 'Asia/Almaty';
export const ALMATY_UTC_OFFSET_MINUTES = 300;

const OFFSET_MS = ALMATY_UTC_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

declare const businessDateBrand: unique symbol;

/** Бизнес-дата без времени, `YYYY-MM-DD`. В БД — тип `date`. */
export type BusinessDate = string & { readonly [businessDateBrand]: true };

export interface AlmatyParts {
  readonly year: number;
  /** 1–12 */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 — воскресенье, 6 — суббота. */
  readonly weekday: number;
}

/** Текущий момент. Единственное обращение к системным часам во всём приложении. */
export function now(): Date {
  return new Date();
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatParts(year: number, month: number, day: number): BusinessDate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` as BusinessDate;
}

/** Собирает бизнес-дату из компонентов, проверяя её существование. */
export function businessDate(year: number, month: number, day: number): BusinessDate {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new RangeError(`Некорректная дата: ${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`);
  }

  return formatParts(year, month, day);
}

/** Разбирает строку `YYYY-MM-DD`. Любой другой формат — ошибка. */
export function parseBusinessDate(value: string): BusinessDate {
  const match = BUSINESS_DATE_PATTERN.exec(value);
  if (match === null) {
    throw new RangeError(`Некорректная дата, ожидается YYYY-MM-DD: ${value}`);
  }

  const [, year, month, day] = match;
  return businessDate(Number(year), Number(month), Number(day));
}

/** Мягкий разбор для фильтров: пустая строка и мусор дают null, а не исключение. */
export function tryParseBusinessDate(value: string): BusinessDate | null {
  try {
    return parseBusinessDate(value);
  } catch {
    return null;
  }
}

export function businessDateToParts(date: BusinessDate): {
  year: number;
  month: number;
  day: number;
} {
  const match = BUSINESS_DATE_PATTERN.exec(date);
  if (match === null) {
    throw new RangeError(`Некорректная дата: ${date}`);
  }

  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/** Раскладывает момент времени по календарю Алматы. */
export function toAlmatyParts(instant: Date): AlmatyParts {
  const shifted = new Date(instant.getTime() + OFFSET_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

/** «Сегодня» в зоне Asia/Almaty. */
export function todayInAlmaty(instant: Date = now()): BusinessDate {
  const parts = toAlmatyParts(instant);
  return formatParts(parts.year, parts.month, parts.day);
}

/** Момент 00:00 указанных суток по Алматы, в UTC. */
export function startOfDayUtc(date: BusinessDate): Date {
  const { year, month, day } = businessDateToParts(date);
  return new Date(Date.UTC(year, month - 1, day) - OFFSET_MS);
}

/** Верхняя граница суток — исключающая: 00:00 следующего дня по Алматы, в UTC. */
export function startOfNextDayUtc(date: BusinessDate): Date {
  return startOfDayUtc(addDays(date, 1));
}

export function addDays(date: BusinessDate, days: number): BusinessDate {
  const { year, month, day } = businessDateToParts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);

  return formatParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * Сдвиг на календарные месяцы. День сохраняется; если в новом месяце такого
 * дня нет, берётся последний — 29 февраля через год становится 28 февраля,
 * а 31 марта через месяц — 30 апреля. Иначе срок документа уползал бы вперёд
 * на следующий месяц (docs/03-BUSINESS-RULES.md §1.3).
 */
export function addMonths(date: BusinessDate, months: number): BusinessDate {
  const { year, month, day } = businessDateToParts(date);
  const shifted = month - 1 + months;
  const targetYear = year + Math.floor(shifted / 12);
  const targetMonth = ((shifted % 12) + 12) % 12;

  return formatParts(
    targetYear,
    targetMonth + 1,
    Math.min(day, daysInMonth(targetYear, targetMonth + 1)),
  );
}

/** Число дней от `from` до `to`. Отрицательное, если `to` раньше. */
export function differenceInDays(from: BusinessDate, to: BusinessDate): number {
  const start = businessDateToParts(from);
  const end = businessDateToParts(to);

  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);

  return Math.round((endMs - startMs) / DAY_MS);
}

export function startOfMonth(date: BusinessDate): BusinessDate {
  const { year, month } = businessDateToParts(date);
  return formatParts(year, month, 1);
}

export function endOfMonth(date: BusinessDate): BusinessDate {
  const { year, month } = businessDateToParts(date);
  return formatParts(year, month, daysInMonth(year, month));
}

/**
 * Разбор момента времени из строки ISO 8601.
 * Нужен там, где сервер отдал время строкой: собственный `new Date`
 * в остальном коде запрещён, и обходить запрет каждый раз заново нельзя.
 */
export function parseInstant(value: string): Date {
  const instant = new Date(value);

  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`Некорректный момент времени: ${value}`);
  }

  return instant;
}

/** Момент, сдвинутый вперёд на указанное число миллисекунд. */
export function plusMilliseconds(instant: Date, milliseconds: number): Date {
  return new Date(instant.getTime() + milliseconds);
}

/** Момент, сдвинутый назад: нужен скользящим окнам вроде ограничения попыток входа. */
export function minusMilliseconds(instant: Date, milliseconds: number): Date {
  return new Date(instant.getTime() - milliseconds);
}

/** Отрицательное — `a` раньше `b`; ноль — совпадают; положительное — `a` позже. */
export function compareBusinessDates(a: BusinessDate, b: BusinessDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
