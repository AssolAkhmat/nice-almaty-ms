import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { testDatabaseUrl, TEST_DATABASE_URL_VARIABLE } from './database-url';

/**
 * Негативные фикстуры к правилу «у тестовой базы нет запасного адреса».
 * Молчаливое `?? 'postgres://…localhost:5432/…'` в каждом db-тесте уводило
 * прогон в чужую базу: порт 5432 на машине разработчика занят другим
 * сервером (инцидент I2).
 */
const SRC_ROOT = join(import.meta.dirname, '..', '..');

function dbTestFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      dbTestFiles(path, found);
    } else if (entry.name.endsWith('.db-test.ts')) {
      found.push(path);
    }
  }

  return found;
}

describe('адрес тестовой базы', () => {
  it('берётся из переменной окружения', () => {
    expect(testDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: 'postgres://x/y' })).toBe(
      'postgres://x/y',
    );
  });

  it('без переменной падает с внятным текстом, а не подставляет свой', () => {
    expect(() => testDatabaseUrl({})).toThrow(/TEST_DATABASE_URL/);
    expect(() => testDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: '   ' })).toThrow(
      /TEST_DATABASE_URL/,
    );
  });

  it('ни один db-тест не подставляет адрес сам', () => {
    const files = dbTestFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('postgres://');
    }
  });
});
