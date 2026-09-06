import { fileURLToPath } from 'node:url';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { dotEnvFallback } from '../scripts/read-dotenv';
import * as schema from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { adminPhone, seedNetwork, SUPERADMIN_PHONE } from '../src/db/seed';

import type { Executor } from '../src/db/client';

/**
 * Подготовка данных для e2e.
 *
 * Продуктовый сид выдаёт случайные пароли и не трогает уже заведённые
 * учётные записи — это правильно для настоящей установки, но тестам нужен
 * предсказуемый вход. Поэтому здесь пароли задаются явно: это фикстура,
 * а не поведение приложения.
 */
export const E2E_PASSWORD = 'e2e-parol-proverki';

export const E2E_ACCOUNTS = {
  superadmin: SUPERADMIN_PHONE,
  adminHouse1: adminPhone(1),
  adminHouse2: adminPhone(2),
} as const;

export default async function globalSetup(): Promise<void> {
  const fileEnv = dotEnvFallback(fileURLToPath(new URL('../.env', import.meta.url)));

  const url =
    process.env.E2E_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    fileEnv.E2E_DATABASE_URL ??
    fileEnv.TEST_DATABASE_URL ??
    'postgres://nice:nice@127.0.0.1:5432/nice_almaty';

  const client = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  const db = drizzle(client, { schema });

  try {
    await seedNetwork({
      executor: db as unknown as Executor,
      passwordFor: () => E2E_PASSWORD,
    });

    /*
     * Счётчики попыток входа обнуляются перед прогоном: окно длится
     * четверть часа и переживает предыдущий запуск, а тестов, которые
     * входят по несколько раз, в наборе много. Это фикстура прогона,
     * а не послабление защиты — правило и его окно остаются прежними.
     */
    await db.delete(schema.rateLimits);

    const phones = Object.values(E2E_ACCOUNTS);

    await db
      .update(schema.users)
      .set({
        passwordHash: await hashPassword(E2E_PASSWORD),
        // Тестам нужен готовый к работе аккаунт: обязательную смену снимаем.
        mustChangePassword: false,
        passwordResetAllowedUntil: null,
      })
      .where(inArray(schema.users.phone, [...phones]));
  } finally {
    await client.end();
  }
}
