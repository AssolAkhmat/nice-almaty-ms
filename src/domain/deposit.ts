import {
  businessDate,
  businessDateToParts,
  compareBusinessDates,
  daysInMonth,
  type BusinessDate,
} from '@/lib/time';

/**
 * Депозит (docs/03-BUSINESS-RULES.md §2).
 * Чистые функции: ни БД, ни часов. Числовые примеры §2.1–2.3 — в тестах.
 */

/** Меньше трёх полных месяцев — депозит сгорает (§2.2). */
export const MIN_FULL_MONTHS_FOR_REFUND = 3;

/**
 * Месяц полный, если проживание покрывает все его календарные дни:
 * заезд не позже первого числа и выезд не раньше последнего (§2.1).
 */
export function countFullMonths(moveIn: BusinessDate, moveOut: BusinessDate): number {
  if (compareBusinessDates(moveIn, moveOut) > 0) {
    return 0;
  }

  const start = businessDateToParts(moveIn);
  const end = businessDateToParts(moveOut);

  let count = 0;
  let year = start.year;
  let month = start.month;

  while (year < end.year || (year === end.year && month <= end.month)) {
    const first = businessDate(year, month, 1);
    const last = businessDate(year, month, daysInMonth(year, month));

    if (compareBusinessDates(moveIn, first) <= 0 && compareBusinessDates(moveOut, last) >= 0) {
      count += 1;
    }

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return count;
}

export interface DepositOutcome {
  /**
   * `refund` — счёт возврата, `burn` — счёт со статусом «Сожжён»,
   * `nothing` — возвращать и сжигать нечего,
   * `debt` — депозит в минусе, возвращать нечего, долг остаётся за жильцом.
   */
  kind: 'refund' | 'burn' | 'nothing' | 'debt';
  /** Сумма счёта возврата или сгорания, целые тенге. */
  amount: number;
  /** Непогашенный перерасход депозита (§2.4), целые тенге. */
  debt: number;
}

export function decideDepositOutcome(input: {
  fullMonths: number;
  /** Остаток депозита, может быть отрицательным после ущерба (§2.4). */
  balance: number;
}): DepositOutcome {
  if (!Number.isSafeInteger(input.balance)) {
    throw new RangeError(
      `Остаток депозита должен быть целым числом тенге: ${String(input.balance)}`,
    );
  }

  if (!Number.isInteger(input.fullMonths) || input.fullMonths < 0) {
    throw new RangeError(`Число полных месяцев не может быть таким: ${String(input.fullMonths)}`);
  }

  /*
   * Отрицательный остаток проверяется раньше срока проживания: сгорать нечему,
   * депозит уже израсходован ущербом. Долг обязан остаться видимым, иначе
   * он потерялся бы при округлении к нулю (§2.4).
   */
  if (input.balance < 0) {
    return { kind: 'debt', amount: 0, debt: -input.balance };
  }

  if (input.balance === 0) {
    return { kind: 'nothing', amount: 0, debt: 0 };
  }

  return {
    kind: input.fullMonths >= MIN_FULL_MONTHS_FOR_REFUND ? 'refund' : 'burn',
    amount: input.balance,
    debt: 0,
  };
}
