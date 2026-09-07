import { startOfDayUtc, startOfMonth, toAlmatyParts, type BusinessDate } from '@/lib/time';

/**
 * Статистика ротаций (docs/04-MODULES/04-rotation-scoring.md).
 *
 * Чистые функции над готовыми записями: кто, где, когда и с какой оценкой.
 * Отменённые ротации в статистику не идут вовсе — они не состоялись (§7),
 * и их присутствие занижало бы и среднее, и долю пропусков.
 */
export interface StatsRecord {
  /** Исполнитель; `null` — назначение осталось без человека. */
  userId: string | null;
  areaId: string;
  date: BusinessDate;
  state: 'assigned' | 'needs_reassignment' | 'confirmed' | 'missed' | 'cancelled';
  /** Оценка 1–10; `null` — админ её не ставил. */
  score: number | null;
}

export interface PersonSummary {
  userId: string;
  done: number;
  missed: number;
  /** Среднее по выставленным оценкам; `null` — оценок не было. */
  averageScore: number | null;
}

export interface MonthSummary {
  /** Первое число месяца. */
  month: BusinessDate;
  done: number;
  missed: number;
  averageScore: number | null;
}

export interface AreaSummary {
  areaId: string;
  done: number;
  missed: number;
  averageScore: number | null;
  /** Доля пропусков от всех состоявшихся назначений зоны. */
  missRate: number;
}

export interface WeekdaySummary {
  /** 0 — воскресенье, 6 — суббота. */
  weekday: number;
  done: number;
  missed: number;
  averageScore: number | null;
}

/** В статистику идут только состоявшиеся: выполненные и пропущенные. */
function counted(records: readonly StatsRecord[]): StatsRecord[] {
  return records.filter((record) => record.state === 'confirmed' || record.state === 'missed');
}

/** Среднее с одним знаком после запятой; без оценок — `null`, а не ноль. */
function average(scores: readonly number[]): number | null {
  if (scores.length === 0) {
    return null;
  }

  const sum = scores.reduce((total, score) => total + score, 0);

  return Math.round((sum / scores.length) * 10) / 10;
}

interface Bucket {
  done: number;
  missed: number;
  scores: number[];
}

function emptyBucket(): Bucket {
  return { done: 0, missed: 0, scores: [] };
}

function collect<K>(
  records: readonly StatsRecord[],
  keyOf: (record: StatsRecord) => K | null,
): Map<K, Bucket> {
  const buckets = new Map<K, Bucket>();

  for (const record of counted(records)) {
    const key = keyOf(record);

    if (key === null) {
      continue;
    }

    const bucket = buckets.get(key) ?? emptyBucket();

    if (record.state === 'missed') {
      bucket.missed += 1;
    } else {
      bucket.done += 1;
    }

    if (record.score !== null) {
      bucket.scores.push(record.score);
    }

    buckets.set(key, bucket);
  }

  return buckets;
}

/**
 * Порядок «сначала худшее»: списки читают сверху, а смотреть в них идут
 * за проблемой. Без оценок строка уходит вниз — судить не о чем.
 */
function byWorstScore(left: number | null, right: number | null): number {
  if (left === right) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left - right;
}

export function summarizeByPerson(records: readonly StatsRecord[]): PersonSummary[] {
  const buckets = collect(records, (record) => record.userId);

  return [...buckets.entries()]
    .map(([userId, bucket]) => ({
      userId,
      done: bucket.done,
      missed: bucket.missed,
      averageScore: average(bucket.scores),
    }))
    .sort((left, right) => byWorstScore(left.averageScore, right.averageScore));
}

export function summarizeMonths(records: readonly StatsRecord[]): MonthSummary[] {
  const buckets = collect(records, (record) => startOfMonth(record.date));

  return [...buckets.entries()]
    .map(([month, bucket]) => ({
      month,
      done: bucket.done,
      missed: bucket.missed,
      averageScore: average(bucket.scores),
    }))
    .sort((left, right) => (left.month < right.month ? -1 : 1));
}

export function summarizeByArea(records: readonly StatsRecord[]): AreaSummary[] {
  const buckets = collect(records, (record) => record.areaId);

  return [...buckets.entries()]
    .map(([areaId, bucket]) => {
      const total = bucket.done + bucket.missed;

      return {
        areaId,
        done: bucket.done,
        missed: bucket.missed,
        averageScore: average(bucket.scores),
        missRate: total === 0 ? 0 : bucket.missed / total,
      };
    })
    .sort((left, right) => byWorstScore(left.averageScore, right.averageScore));
}

export function summarizeByWeekday(records: readonly StatsRecord[]): WeekdaySummary[] {
  const buckets = collect(records, (record) => toAlmatyParts(startOfDayUtc(record.date)).weekday);

  return [...buckets.entries()]
    .map(([weekday, bucket]) => ({
      weekday,
      done: bucket.done,
      missed: bucket.missed,
      averageScore: average(bucket.scores),
    }))
    .sort((left, right) => byWorstScore(left.averageScore, right.averageScore));
}
