import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { dotEnvFallback } from '../scripts/read-dotenv';
import * as schema from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { seedNetwork, SUPERADMIN_PHONE } from '../src/db/seed';

import type { Executor } from '../src/db/client';

/**
 * Пустая база для приёмки первого дня (T9.13).
 *
 * База пересоздаётся целиком перед каждым прогоном: уборка за собой здесь
 * не нужна, потому что «пусто» — это и есть исходное состояние. Схема
 * накатывается теми же миграциями, что и везде, состав — скелет сети
 * (`pnpm db:seed --skeleton`, P7-21): организация, суперадмин, типы
 * документов, счета и шаблон договора, ни одного дома.
 *
 * Имя базы отличается от основной тестовой: сервер тот же, и пустая база
 * живёт рядом с ней, не мешая основной приёмке.
 */
export const EMPTY_DATABASE_NAME = 'nice_almaty_empty';

export const E2E_EMPTY_PASSWORD = 'e2e-parol-pustoy-bazy';

const fileEnv = dotEnvFallback(fileURLToPath(new URL('../.env', import.meta.url)));

/** Адрес основной тестовой базы: от неё берутся сервер и учётные данные. */
function baseDatabaseUrl(): string {
  return (
    process.env.E2E_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    fileEnv.E2E_DATABASE_URL ??
    fileEnv.TEST_DATABASE_URL ??
    'postgres://nice:nice@127.0.0.1:5432/nice_almaty'
  );
}

export function emptyDatabaseUrl(): string {
  const url = new URL(baseDatabaseUrl());
  url.pathname = `/${EMPTY_DATABASE_NAME}`;

  return url.toString();
}

export default async function globalSetup(): Promise<void> {
  const server = postgres(baseDatabaseUrl(), {
    max: 1,
    connect_timeout: 10,
    onnotice: () => undefined,
  });

  try {
    await server.unsafe(`drop database if exists ${EMPTY_DATABASE_NAME} with (force)`);
    await server.unsafe(`create database ${EMPTY_DATABASE_NAME}`);
  } finally {
    await server.end();
  }

  const client = postgres(emptyDatabaseUrl(), {
    max: 1,
    connect_timeout: 10,
    onnotice: () => undefined,
  });

  try {
    const db = drizzle(client, { schema });

    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    });

    await seedNetwork({
      executor: db as unknown as Executor,
      passwordFor: () => E2E_EMPTY_PASSWORD,
      houses: 0,
      withContent: false,
    });

    // Тестам нужен готовый к работе суперадмин: обязательную смену снимаем.
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(E2E_EMPTY_PASSWORD), mustChangePassword: false })
      .where(eq(schema.users.phone, SUPERADMIN_PHONE));

    /*
     * Ещё пустее скелета: ни плана счетов, ни типов документов, ни шаблона
     * договора. Ровно так выглядела боевая база после инцидента I9, и экраны
     * обязаны пережить и это — пустым состоянием, а не серверной ошибкой.
     */
    await db.delete(schema.accounts);
    await db.delete(schema.documentTypes);
    await db.delete(schema.contractTemplates);
  } finally {
    await client.end();
  }
}
