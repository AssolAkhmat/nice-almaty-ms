import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { loadEnv } from '@/lib/env/load';

import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

/** Транзакция drizzle: тот же интерфейс запросов, что и у базы. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * То, на чём выполняется запрос: база или открытая транзакция.
 * Репозитории принимают это, чтобы сервисы могли собрать несколько
 * изменений и запись в аудит в одну транзакцию.
 */
export type Executor = Database | Transaction;

let sql: postgres.Sql | undefined;
let database: Database | undefined;

/**
 * Настройки пула — единственное место, где различаются окружения
 * (docs/01-ARCHITECTURE.md). На Vercel подключение идёт через пулер
 * Supabase в режиме transaction pooling: подготовленные выражения там
 * не работают, а держать много соединений из serverless нельзя.
 */
function createClient(): postgres.Sql {
  const env = loadEnv();
  const isVercel = env.DEPLOY_TARGET === 'vercel';

  return postgres(env.DATABASE_URL, {
    max: isVercel ? 1 : 10,
    prepare: !isVercel,
    idle_timeout: isVercel ? 20 : undefined,
  });
}

/** Соединение не открывается до первого запроса: postgres-js подключается лениво. */
export function getSql(): postgres.Sql {
  sql ??= createClient();
  return sql;
}

export function getDb(): Database {
  database ??= drizzle(getSql(), { schema });
  return database;
}

/** Закрытие пула: нужно воркеру и одноразовым скриптам. */
export async function closeDb(): Promise<void> {
  if (sql !== undefined) {
    await sql.end();
    sql = undefined;
    database = undefined;
  }
}
