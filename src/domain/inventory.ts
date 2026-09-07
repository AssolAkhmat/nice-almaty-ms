/**
 * Количества инвентаря (docs/02-DATA-MODEL.md, «Инвентарь»).
 *
 * В базе `numeric(12,2)`: у инвентаря своя единица измерения, и полтора
 * литра краски существуют. Правило целых тенге сюда не переносится —
 * оно про деньги (§0). Но и считать дробное в `number` нельзя по той же
 * причине, по какой нельзя деньги: `0.1 + 0.2` не даёт `0.3`. Поэтому
 * количество живёт целым числом сотых долей, а строка `numeric` — это
 * только формат хранения и показа.
 */
const SCALE = 100;

const QTY_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export class InventoryQtyError extends RangeError {
  constructor(value: string) {
    super(`Некорректное количество: ${value}`);
    this.name = 'InventoryQtyError';
  }
}

/** Разбирает `numeric(12,2)` в сотые доли. */
export function parseQty(value: string): number {
  const trimmed = value.trim();

  if (!QTY_PATTERN.test(trimmed)) {
    throw new InventoryQtyError(value);
  }

  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = trimmed.replace('-', '').split('.');
  const hundredths = Number(whole) * SCALE + Number(fraction.padEnd(2, '0'));

  return negative ? -hundredths : hundredths;
}

/** Собирает строку `numeric(12,2)` из сотых долей. */
export function formatQty(hundredths: number): string {
  if (!Number.isInteger(hundredths)) {
    throw new InventoryQtyError(String(hundredths));
  }

  const sign = hundredths < 0 ? '-' : '';
  const absolute = Math.abs(hundredths);

  return `${sign}${String(Math.floor(absolute / SCALE))}.${String(absolute % SCALE).padStart(2, '0')}`;
}

export type MovementType = 'in' | 'out' | 'write_off' | 'transfer' | 'audit_adjust';

/**
 * Как движение меняет количество позиции.
 *
 * Приход прибавляет, расход и списание вычитают. Перемещение количество
 * дома не меняет — меняется дом, а не число: позиция переезжает целиком.
 * Корректировка по инвентаризации приходит уже со знаком: она и есть
 * разница между фактом и учётом.
 */
export function applyMovement(qty: number, type: MovementType, amount: number): number {
  switch (type) {
    case 'in':
      return qty + amount;
    case 'out':
    case 'write_off':
      return qty - amount;
    case 'transfer':
      return qty;
    case 'audit_adjust':
      return qty + amount;
  }
}

/**
 * Расхождение ведомости: факт минус учёт.
 *
 * Положительное — нашли больше, чем числится; отрицательное — недостача.
 * Непроверенная строка расхождения не даёт: пустое поле — это «не
 * считали», а не «ноль».
 */
export function auditDifference(expected: string, actual: string | null): number | null {
  if (actual === null) {
    return null;
  }

  return parseQty(actual) - parseQty(expected);
}
