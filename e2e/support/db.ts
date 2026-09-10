import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { dotEnvFallback } from '../../scripts/read-dotenv';
import * as schema from '../../src/db/schema';

/**
 * База прогона приёмок: та же, что у сервера под тестами.
 *
 * Адрес берётся из окружения, потом из `.env`; запасной — локальный
 * контейнер на 55432. Так `global-setup` готовит данные, и так же
 * приёмка фазы 10 строит свой дом.
 */
export function databaseUrl(): string {
  const fileEnv = dotEnvFallback(fileURLToPath(new URL('../../.env', import.meta.url)));

  return (
    process.env.E2E_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    fileEnv.E2E_DATABASE_URL ??
    fileEnv.TEST_DATABASE_URL ??
    'postgres://nice:nice@127.0.0.1:55432/nice_almaty'
  );
}

export function openDb() {
  const client = postgres(databaseUrl(), {
    max: 1,
    connect_timeout: 10,
    onnotice: () => undefined,
  });

  return { db: drizzle(client, { schema }), close: () => client.end() };
}

export type E2eDb = ReturnType<typeof openDb>['db'];
