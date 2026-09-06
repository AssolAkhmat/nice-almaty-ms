import { addDays, compareBusinessDates, differenceInDays, type BusinessDate } from '@/lib/time';

/**
 * Расторжение договора (docs/03-BUSINESS-RULES.md §2.3).
 * Чистые функции: ни БД, ни часов. Сегодняшний день приходит параметром.
 */

/** Крайний срок возврата депозита — 30 дней от даты расторжения (§2.3 п.4). */
export const REFUND_DEADLINE_DAYS = 30;

export function refundDeadline(terminatedOn: BusinessDate): BusinessDate {
  return addDays(terminatedOn, REFUND_DEADLINE_DAYS);
}

/**
 * Сколько дней осталось до крайнего срока. Ноль — сегодня последний день,
 * отрицательное — просрочка: она обязана быть видна числом, иначе счётчик
 * замер бы на нуле и просрочка стала бы неотличима от срока.
 */
export function daysUntilRefundDeadline(terminatedOn: BusinessDate, today: BusinessDate): number {
  return differenceInDays(today, refundDeadline(terminatedOn));
}

/** Почему такая дата выезда не годится. `null` — годится. */
export type MoveOutDateProblem = 'inPast' | 'beforeMoveIn';

/**
 * Дата выезда: «по умолчанию сегодня, можно будущую»
 * (docs/04-MODULES/01-onboarding.md). Прошлое правилом не предусмотрено,
 * поэтому отклоняется: задним числом освобождённое место разошлось бы
 * с занятостью, по которой уже выставлены счета.
 */
export function moveOutDateProblem(input: {
  moveIn: BusinessDate | null;
  moveOut: BusinessDate;
  today: BusinessDate;
}): MoveOutDateProblem | null {
  if (compareBusinessDates(input.moveOut, input.today) < 0) {
    return 'inPast';
  }

  if (input.moveIn !== null && compareBusinessDates(input.moveOut, input.moveIn) < 0) {
    return 'beforeMoveIn';
  }

  return null;
}
