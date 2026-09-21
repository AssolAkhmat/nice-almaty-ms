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

/**
 * Разбивка инвентаря по зонам дома (модуль 10, указание владельца
 * 21 сентября 2026).
 *
 * Позиция без зоны — нормальное состояние: «по дому вообще». Такие идут
 * отдельной группой и последними: приписать их к чужой зоне нельзя,
 * а потерять — тем более.
 *
 * Стоимость группы считается в целых тенге: количество умножается на цену
 * единицы через сотые доли, поэтому дробное количество не порождает копеек
 * и не ломает правило §0.
 */
export interface ZonedItem {
  areaId: string | null;
  areaName: string | null;
  qty: string;
  unitCost: number;
}

export interface AreaGroup<Item extends ZonedItem> {
  areaId: string | null;
  /** `null` — группа «без зоны»; название подставляет интерфейс. */
  areaName: string | null;
  items: Item[];
  /** Сумма `количество × стоимость единицы`, целые тенге. */
  totalCost: number;
}

export function groupItemsByArea<Item extends ZonedItem>(
  items: readonly Item[],
): AreaGroup<Item>[] {
  const groups = new Map<string, AreaGroup<Item>>();

  for (const item of items) {
    const key = item.areaId ?? '';
    const group = groups.get(key) ?? {
      areaId: item.areaId,
      areaName: item.areaName,
      items: [],
      totalCost: 0,
    };

    group.items.push(item);
    // Округление вверх — правило §0: доля тенге в пользу дома.
    group.totalCost += Math.ceil((parseQty(item.qty) * item.unitCost) / SCALE);
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => {
    if (left.areaId === null) {
      return 1;
    }

    if (right.areaId === null) {
      return -1;
    }

    return (left.areaName ?? '').localeCompare(right.areaName ?? '', 'ru');
  });
}
