import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { dotEnvFallback } from '../../scripts/read-dotenv';
import { e2eDatabaseUrl } from '../../src/db/testing/database-url';
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

  return e2eDatabaseUrl(process.env, fileEnv);
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
