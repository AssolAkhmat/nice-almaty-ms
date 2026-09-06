/**
 * Деньги: целые тенге, тиынов нет (docs/03-BUSINESS-RULES.md §0).
 * Чистые функции: без БД, без обращения к часам.
 */

export interface SplitResult {
  /** Доли участников в порядке переданных весов. Каждая — целое число тенге. */
  readonly shares: readonly number[];
  /** Превышение суммы долей над исходной суммой. Остаётся дому (§0). */
  readonly surplus: number;
}

function assertMoneyAmount(total: number): void {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError(
      `Сумма к делению должна быть целым неотрицательным числом тенге, получено: ${String(total)}`,
    );
  }
}

function assertWeights(weights: readonly number[]): void {
  if (weights.length === 0) {
    throw new RangeError('Нет участников: делить сумму не между кем');
  }

  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError(
        `Вес участника должен быть целым неотрицательным числом, получено: ${String(weight)}`,
      );
    }
  }
}

/** Целочисленное деление с округлением вверх. Без плавающей точки — деньги не округляем дважды. */
function ceilDiv(dividend: number, divisor: number): number {
  return Math.floor((dividend + divisor - 1) / divisor);
}

/**
 * Делит сумму между участниками пропорционально весам.
 * Доля каждого округляется вверх до целого тенге, поэтому сумма долей
 * может превысить исходную; излишек возвращается отдельным полем (§0).
 *
 * Веса — целые: это дни проживания, число человек, доли комнаты.
 *
 * Пример §0.1: splitCeil(1800, 17 × [1]) -> по 106, сумма 1802, surplus = 2.
 */
export function splitCeil(total: number, weights: readonly number[]): SplitResult {
  assertMoneyAmount(total);
  assertWeights(weights);

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight === 0) {
    throw new RangeError('Сумма весов равна нулю: пропорцию деления определить нельзя');
  }

  const shares = weights.map((weight) => {
    const numerator = total * weight;
    if (!Number.isSafeInteger(numerator)) {
      throw new RangeError('Сумма к делению слишком велика для точного целочисленного расчёта');
    }
    return ceilDiv(numerator, totalWeight);
  });

  const distributed = shares.reduce((sum, share) => sum + share, 0);

  return { shares, surplus: distributed - total };
}
