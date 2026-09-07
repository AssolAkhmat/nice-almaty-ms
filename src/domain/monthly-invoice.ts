import { compareBusinessDates, startOfMonth, type BusinessDate } from '@/lib/time';

/**
 * Месячный счёт (docs/03-BUSINESS-RULES.md §3).
 *
 * Чистая сборка строк: сервис приносит цену, долю коммуналки и долг депозита,
 * а решение, какие строки в счёт войдут и в каком порядке, принимается здесь
 * и проверяется числами.
 *
 * Порядок строк — из таблицы §3: проживание, коммуналка, штрафы, погашение
 * перерасхода депозита, ручные начисления, скидка за рейтинг.
 */
export type MonthlyLineKind =
  'rent' | 'utilities' | 'fine' | 'damage_carryover' | 'extra' | 'discount';

export interface MonthlyInvoiceLine {
  kind: MonthlyLineKind;
  title: string;
  amount: number;
}

export interface ManualLine {
  title: string;
  amount: number;
}

/** Назначение места с ценой: цена берётся из того, что действует 1 числа. */
export interface PricedAssignment {
  price: number;
  from: BusinessDate;
  /** Пусто — назначение действует до сих пор. */
  to: BusinessDate | null;
}

export interface MonthlyInvoiceInput {
  /** Первое число месяца, за который выставляется счёт. */
  month: BusinessDate;
  /** Цена проживания на первое число месяца; всегда полная сумма (§3). */
  rent: number;
  /** Доля за прошлый месяц; `null` — период ещё не закрыт (§4.2). */
  utilities?: { amount: number; title: string } | null;
  /** Начисленные штрафы (§5.3): каждый своей строкой, в порядке начисления. */
  fines?: readonly ManualLine[];
  /** Непогашенный перерасход депозита (§2.4); ноль — строки нет. */
  depositDebt?: number;
  manualLines?: readonly ManualLine[];
  /** Скидка за рейтинг (§5.4): наибольшая подтверждённая, одна на счёт. */
  discount?: { title: string; amount: number } | null;
}

export interface MonthlyInvoiceDraft {
  lines: MonthlyInvoiceLine[];
  total: number;
}

function assertMoney(amount: number): void {
  // Деньги — целые тенге (§0). Дробь и минус в начислении означают ошибку ввода.
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`Начисление должно быть целым числом тенге, получено: ${String(amount)}`);
  }
}

/**
 * Цена проживания на первое число месяца. Смена цены или места внутри месяца
 * текущий счёт не меняет: перерасчёт делается вручную отдельной строкой (§3).
 */
export function rentForMonth(
  month: BusinessDate,
  assignments: readonly PricedAssignment[],
): number {
  const first = startOfMonth(month);

  const active = assignments.find(
    (assignment) =>
      compareBusinessDates(assignment.from, first) <= 0 &&
      (assignment.to === null || compareBusinessDates(first, assignment.to) < 0),
  );

  return active?.price ?? 0;
}

export function buildMonthlyInvoice(input: MonthlyInvoiceInput): MonthlyInvoiceDraft {
  assertMoney(input.rent);

  const lines: MonthlyInvoiceLine[] = [{ kind: 'rent', title: 'Проживание', amount: input.rent }];

  if (input.utilities != null) {
    assertMoney(input.utilities.amount);
    lines.push({
      kind: 'utilities',
      title: input.utilities.title,
      amount: input.utilities.amount,
    });
  }

  for (const fine of input.fines ?? []) {
    assertMoney(fine.amount);
    lines.push({ kind: 'fine', title: fine.title, amount: fine.amount });
  }

  const debt = input.depositDebt ?? 0;
  assertMoney(debt);

  if (debt > 0) {
    lines.push({
      kind: 'damage_carryover',
      title: 'Погашение перерасхода депозита',
      amount: debt,
    });
  }

  for (const manual of input.manualLines ?? []) {
    assertMoney(manual.amount);
    lines.push({ kind: 'extra', title: manual.title, amount: manual.amount });
  }

  /*
   * Скидка уменьшает проживание и только его (§5.4): «проживание не может
   * стать отрицательным». Из коммуналки и штрафов она не вычитается —
   * это чужие деньги, фонд дома и наказание, а не плата за место.
   */
  if (input.discount != null) {
    assertMoney(input.discount.amount);

    const applied = Math.min(input.discount.amount, input.rent);

    if (applied > 0) {
      lines.push({ kind: 'discount', title: input.discount.title, amount: -applied });
    }
  }

  return { lines, total: lines.reduce((sum, line) => sum + line.amount, 0) };
}
