import { eq, lt, sql } from 'drizzle-orm';

import { minusMilliseconds, now } from '@/lib/time';

import { getDb, type Executor } from '../client';
import { rateLimits } from '../schema';

/**
 * Счётчик попыток в скользящем окне (P1-2).
 * Контекста доступа тут нет: ограничение работает до входа, когда его ещё нет.
 */
export interface RateLimitState {
  count: number;
  windowStart: Date;
}

/**
 * Увеличивает счётчик и возвращает состояние окна.
 * Окно старше `windowMs` начинается заново — за это отвечает один запрос,
 * иначе между чтением и записью влезала бы гонка.
 */
export async function hitRateLimit(
  key: string,
  windowMs: number,
  executor: Executor = getDb(),
): Promise<RateLimitState> {
  const moment = now();
  const windowStart = minusMilliseconds(moment, windowMs);

  /*
   * В шаблон sql`` даты уходят строками с явным приведением типа:
   * объект Date драйвер postgres-js в параметре шаблона не принимает.
   */
  const boundary = sql`${windowStart.toISOString()}::timestamptz`;
  const stamp = sql`${moment.toISOString()}::timestamptz`;
  const isSameWindow = sql`${rateLimits.windowStart} > ${boundary}`;

  const [row] = await executor
    .insert(rateLimits)
    .values({ key, windowStart: moment, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${isSameWindow} then ${rateLimits.count} + 1 else 1 end`,
        windowStart: sql`case when ${isSameWindow} then ${rateLimits.windowStart} else ${stamp} end`,
      },
    })
    .returning({ count: rateLimits.count, windowStart: rateLimits.windowStart });

  if (row === undefined) {
    throw new Error('Счётчик попыток не обновлён');
  }

  return row;
}

/** Успешный вход обнуляет счётчик. */
export async function resetRateLimit(key: string, executor: Executor = getDb()): Promise<void> {
  await executor.delete(rateLimits).where(eq(rateLimits.key, key));
}

/** Ленивая уборка просроченных окон; отдельное задание появится в фазе 6. */
export async function purgeExpiredRateLimits(
  windowMs: number,
  executor: Executor = getDb(),
): Promise<void> {
  const threshold = minusMilliseconds(now(), windowMs);

  await executor.delete(rateLimits).where(lt(rateLimits.windowStart, threshold));
}
