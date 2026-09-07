import {
  addDays,
  businessDate,
  businessDateToParts,
  daysInMonth,
  startOfDayUtc,
  toAlmatyParts,
  type BusinessDate,
} from '@/lib/time';

/**
 * Генеральная уборка (docs/03-BUSINESS-RULES.md §6.5).
 *
 * Последнее воскресенье месяца, участвуют все жильцы дома, включая админа.
 * Зоны раздаются случайно, но детерминированно: сид — дом и дата, поэтому
 * один и тот же день всегда даёт один и тот же расклад, а перетаскивание
 * результата остаётся за админом.
 */
export interface GeneralZone {
  areaId: string;
  checklistId: string;
  peopleNeeded: number;
  /** Кого пускает группа допуска зоны; пусто — не пускает никого. */
  eligibleUserIds: readonly string[];
}

export interface GeneralAssignment {
  areaId: string;
  checklistId: string;
  /** Ровно `peopleNeeded` мест; `null` — некому убирать, место видно админу. */
  userIds: (string | null)[];
}

/** Последнее воскресенье месяца, в котором лежит дата. */
export function lastSundayOfMonth(date: BusinessDate): BusinessDate {
  const { year, month } = businessDateToParts(date);
  const last = businessDate(year, month, daysInMonth(year, month));
  const weekday = toAlmatyParts(startOfDayUtc(last)).weekday;

  return weekday === 0 ? last : addDays(last, -weekday);
}

/**
 * Детерминированный генератор из строки-сида.
 *
 * Свой, а не из библиотеки: нужна ровно повторяемость по строке, а тянуть
 * зависимость ради тридцати строк — лишний рантайм в сборке (CLAUDE.md §1).
 */
function seededRandom(seed: string): () => number {
  let state = 0x811c9dc5;

  for (const char of seed) {
    state ^= char.codePointAt(0) ?? 0;
    state = Math.imul(state, 0x01000193) >>> 0;
  }

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Перемешивание Фишера — Йетса на детерминированном генераторе. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const left = result[index];
    const right = result[swap];

    if (left !== undefined && right !== undefined) {
      result[index] = right;
      result[swap] = left;
    }
  }

  return result;
}

/**
 * Раздача зон генеральной уборки.
 *
 * Порядок зон при раздаче — от самой закрытой к самой открытой: зона, куда
 * пускают одного человека, обязана достаться ему, иначе она останется пустой
 * при полном доме. Человек убирает не больше одной зоны, пока людей хватает.
 *
 * Порядок людей на входе на результат не влияет: список сортируется перед
 * перемешиванием, и расклад зависит только от сида.
 */
export function distributeGeneralCleaning(
  seed: string,
  zones: readonly GeneralZone[],
  people: readonly string[],
): GeneralAssignment[] {
  for (const zone of zones) {
    if (!Number.isInteger(zone.peopleNeeded) || zone.peopleNeeded < 1) {
      throw new RangeError(
        `people_needed зоны ${zone.areaId} должно быть целым числом от единицы, задано: ${String(zone.peopleNeeded)}`,
      );
    }
  }

  const random = seededRandom(seed);
  const order = shuffle([...people].sort(), random);
  const taken = new Set<string>();

  const byScarcity = zones
    .map((zone, index) => ({ zone, index }))
    .sort((left, right) => {
      const leftRoom = left.zone.eligibleUserIds.length - left.zone.peopleNeeded;
      const rightRoom = right.zone.eligibleUserIds.length - right.zone.peopleNeeded;

      return leftRoom === rightRoom ? left.index - right.index : leftRoom - rightRoom;
    });

  const result: GeneralAssignment[] = zones.map((zone) => ({
    areaId: zone.areaId,
    checklistId: zone.checklistId,
    userIds: [],
  }));

  for (const { zone, index } of byScarcity) {
    const eligible = new Set(zone.eligibleUserIds);
    const picked: (string | null)[] = [];

    for (const userId of order) {
      if (picked.length === zone.peopleNeeded) {
        break;
      }

      if (eligible.has(userId) && !taken.has(userId)) {
        picked.push(userId);
        taken.add(userId);
      }
    }

    // Людей не хватило — места остаются пустыми и видны админу задачей,
    // а не исчезают вместе с уборкой (§6.3).
    while (picked.length < zone.peopleNeeded) {
      picked.push(null);
    }

    const target = result[index];
    if (target !== undefined) {
      target.userIds = picked;
    }
  }

  return result;
}
