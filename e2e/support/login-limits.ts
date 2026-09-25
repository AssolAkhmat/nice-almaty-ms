import { drizzle } from 'drizzle-orm/postgres-js';
import { like } from 'drizzle-orm';
import postgres from 'postgres';

import * as schema from '../../src/db/schema';

import { databaseUrl } from './db';

/**
 * Сброс счётчиков попыток входа перед каждым входом приёмки.
 *
 * Вход ограничен десятью попытками за пятнадцать минут на телефон и на адрес
 * (P1-2) — правильная защита от подбора. Приёмка же входит настоящей формой
 * сотни раз за прогон, с одного адреса и под несколькими учётными записями:
 * после десятого входа всё остальное отбивалось «слишком много попыток»,
 * и падали не отдельные проверки, а весь прогон целиком — 322 штуки.
 *
 * Ограничение при этом снимать нельзя: оно боевое. Поэтому приёмка чистит
 * **свои** счётчики, ровно как чистит своих жильцов и свои дома. Продуктовый
 * код не знает об этом ничего, и негативные фикстуры на сам лимит
 * (`src/services/auth.db-test.ts`) продолжают его проверять.
 */
let pool: ReturnType<typeof postgres> | null = null;

function database() {
  pool ??= postgres(databaseUrl(), { max: 1, connect_timeout: 10, onnotice: () => undefined });

  return drizzle(pool, { schema });
}

export async function clearLoginLimits(): Promise<void> {
  await database().delete(schema.rateLimits).where(like(schema.rateLimits.key, 'login:%'));
}
