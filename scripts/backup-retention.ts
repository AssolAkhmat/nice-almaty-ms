/**
 * Какие копии базы остаются на Drive, а какие уходят (docs/BACKUP.md).
 *
 * Правило «сутки — недели — месяцы»: семь последних ежедневных, по одной
 * на каждую из четырёх последних недель и по одной на каждый из шести
 * последних месяцев. Пропущенные дни не ломают счёт: неделя и месяц
 * считаются по тому, что есть, а не по календарю. Прогон, не случившийся
 * в воскресенье, не должен стоить недельной копии.
 *
 * Чистая функция: решение о **удалении** обязано проверяться числовыми
 * примерами, а не наблюдением за живой папкой.
 */
const PREFIX = 'nice-almaty-';
const SUFFIX = '.dump.age';

const NAME_PATTERN = new RegExp(`^${PREFIX}(\\d{4}-\\d{2}-\\d{2})${SUFFIX}$`);

const DAY_MS = 86_400_000;

export interface RetentionPolicy {
  readonly daily: number;
  readonly weekly: number;
  readonly monthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4, monthly: 6 };

export interface RetentionPlan {
  /** Копии, которые остаются. */
  readonly keep: string[];
  /** Копии, которые удаляются. */
  readonly remove: string[];
  /**
   * Файлы, которые ротация не опознала. Они не удаляются никогда:
   * чужой файл в папке бэкапов — повод разобраться, а не стереть.
   */
  readonly foreign: string[];
}

export function backupName(date: string): string {
  return `${PREFIX}${date}${SUFFIX}`;
}

/** Дата копии из имени файла. `null` — имя не наше. */
export function backupDate(name: string): string | null {
  return NAME_PATTERN.exec(name)?.[1] ?? null;
}

/** Номер недели по ISO: неделя принадлежит году своего четверга. */
function weekKey(date: string): string {
  const thursday = new Date(`${date}T00:00:00Z`);
  const weekday = (thursday.getUTCDay() + 6) % 7;

  thursday.setUTCDate(thursday.getUTCDate() - weekday + 3);

  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));

  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);

  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));

  return `${String(year)}-W${String(week).padStart(2, '0')}`;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

/** Новейшая копия каждой из последних `limit` групп. */
function newestPerGroup(
  entries: readonly { name: string; date: string }[],
  key: (date: string) => string,
  limit: number,
): string[] {
  const chosen = new Map<string, string>();

  // Нулевой предел — это «ни одной», а не «по одной на группу»:
  // проверка размера после добавления пропускала первую копию каждой группы.
  if (limit <= 0) {
    return [];
  }

  for (const entry of entries) {
    const group = key(entry.date);

    if (!chosen.has(group)) {
      chosen.set(group, entry.name);
    }

    if (chosen.size === limit) {
      break;
    }
  }

  return [...chosen.values()];
}

export function planRetention(
  names: readonly string[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
): RetentionPlan {
  const foreign: string[] = [];
  const entries: { name: string; date: string }[] = [];

  for (const name of names) {
    const date = backupDate(name);

    if (date === null) {
      foreign.push(name);
      continue;
    }

    entries.push({ name, date });
  }

  // От новых к старым: все три правила смотрят на «последние», а не на «первые».
  entries.sort((left, right) => right.date.localeCompare(left.date));

  const keep = new Set<string>([
    ...entries.slice(0, policy.daily).map((entry) => entry.name),
    ...newestPerGroup(entries, weekKey, policy.weekly),
    ...newestPerGroup(entries, monthKey, policy.monthly),
  ]);

  return {
    keep: entries.filter((entry) => keep.has(entry.name)).map((entry) => entry.name),
    remove: entries.filter((entry) => !keep.has(entry.name)).map((entry) => entry.name),
    foreign,
  };
}
