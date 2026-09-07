/**
 * Калькулятор налогов (docs/03-BUSINESS-RULES.md §10.2).
 *
 * Расчёт справочный: он ничего не проводит и налоговой консультацией
 * не является — так и написано на экране. Здесь только арифметика,
 * ни БД, ни часов.
 *
 * Ставки хранятся в базисных пунктах, а не процентами с дробью: 0,95 %
 * в виде числа с плавающей точкой рано или поздно даст 0,9499999,
 * а деньги — целые тенге (§0).
 */

/** Налог с дохода через Kaspi: 3 % (значение по умолчанию от владельца). */
export const TAX_RATE_BP = 300;

/** Эквайринг: 0,95 % (значение по умолчанию от владельца). */
export const ACQUIRING_RATE_BP = 95;

const BASIS_POINTS = 10_000;

export interface TaxInput {
  /** Доход через Kaspi за период, целые тенге. */
  kaspiIncome: number;
  /** Оборот через Kaspi за период: с него берётся эквайринг. */
  kaspiTurnover: number;
  taxRateBp: number;
  acquiringRateBp: number;
}

export interface TaxReport {
  tax: number;
  acquiring: number;
  /** Итого к вычету: налог плюс комиссия. */
  deduction: number;
  /** Чистыми: доход минус вычет. */
  net: number;
}

function assertAmount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${what} должно быть целым неотрицательным числом, получено: ${String(value)}`,
    );
  }
}

/**
 * Доля от суммы по ставке в базисных пунктах, округлённая вверх.
 * Вверх — потому что справка о налоге не должна занижать сумму к уплате:
 * недоплата дороже переплаты на тенге.
 */
function applyRate(amount: number, rateBp: number): number {
  const numerator = amount * rateBp;

  if (!Number.isSafeInteger(numerator)) {
    throw new RangeError('Сумма слишком велика для точного целочисленного расчёта');
  }

  return Math.ceil(numerator / BASIS_POINTS);
}

export function taxReport(input: TaxInput): TaxReport {
  assertAmount(input.kaspiIncome, 'Доход через Kaspi');
  assertAmount(input.kaspiTurnover, 'Оборот через Kaspi');
  assertAmount(input.taxRateBp, 'Ставка налога');
  assertAmount(input.acquiringRateBp, 'Ставка эквайринга');

  const tax = applyRate(input.kaspiIncome, input.taxRateBp);
  const acquiring = applyRate(input.kaspiTurnover, input.acquiringRateBp);

  return {
    tax,
    acquiring,
    deduction: tax + acquiring,
    net: input.kaspiIncome - tax - acquiring,
  };
}
