import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';

import {
  appliedMigrations,
  EXPECTED_MIGRATIONS,
  MIGRATIONS,
  schemaProblem,
} from './schema-version';

import type { Database } from './client';

/**
 * Версия схемы (указание владельца, `docs/DEPLOY-VERCEL.md` §10).
 *
 * Приложение обязано падать понятной ошибкой, если миграции не применены.
 * Проверяется само сравнение и то, что список в коде совпадает с базой,
 * на которой идут интеграционные тесты.
 */
const url = testDatabaseUrl();
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

afterAll(async () => {
  await client.end();
});

describe('сравнение версий', () => {
  it('отставшая база названа по числам', () => {
    const applied = EXPECTED_MIGRATIONS - 2;

    expect(schemaProblem(applied)).toBe(
      `применено ${String(applied)} из ${String(EXPECTED_MIGRATIONS)}`,
    );
  });

  it('совпадение молчит', () => {
    expect(schemaProblem(EXPECTED_MIGRATIONS)).toBeNull();
  });

  it('база впереди кода — не ошибка: так выглядит выкатка', () => {
    expect(schemaProblem(EXPECTED_MIGRATIONS + 1)).toBeNull();
  });
});

describe('живая база', () => {
  it('применено ровно столько миграций, сколько знает код', async () => {
    expect(await appliedMigrations(db)).toBeGreaterThanOrEqual(EXPECTED_MIGRATIONS);
  });

  it('список миграций не пуст и заканчивается последней из папки', () => {
    expect(MIGRATIONS.length).toBe(EXPECTED_MIGRATIONS);
    expect(MIGRATIONS.at(-1)).toMatch(/^\d{4}_.+\.sql$/);
  });
});
