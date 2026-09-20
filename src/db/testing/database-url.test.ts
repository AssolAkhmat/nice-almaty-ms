import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  e2eDatabaseUrl,
  testDatabaseUrl,
  E2E_DATABASE_URL_VARIABLE,
  TEST_DATABASE_URL_VARIABLE,
} from './database-url';

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

/**
 * То же правило для приёмок. До 20 сентября 2026 три конфигурации
 * подставляли `postgres://nice:nice@…`, причём две на порт 5432, а третья
 * на 55432: после смены пароля базы такой адрес перестал вести куда-либо
 * и показывал ошибку авторизации вместо «переменная не задана».
 */
const REPO_ROOT = join(SRC_ROOT, '..');

function e2eConfigFiles(): string[] {
  const roots = [join(REPO_ROOT, 'e2e'), join(REPO_ROOT, 'e2e-empty')];
  const found = [
    join(REPO_ROOT, 'playwright.config.ts'),
    join(REPO_ROOT, 'playwright.empty.config.ts'),
  ];

  for (const root of roots) {
    const stack = [root];

    while (stack.length > 0) {
      const directory = stack.pop() ?? '';

      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
          stack.push(path);
        } else if (entry.name.endsWith('.ts')) {
          found.push(path);
        }
      }
    }
  }

  return found;
}

describe('адрес базы приёмок', () => {
  it('окружение сильнее файла', () => {
    expect(
      e2eDatabaseUrl(
        { [TEST_DATABASE_URL_VARIABLE]: 'postgres://из-окружения/y' },
        {
          [TEST_DATABASE_URL_VARIABLE]: 'postgres://из-файла/y',
        },
      ),
    ).toBe('postgres://из-окружения/y');
  });

  it('E2E_DATABASE_URL сильнее TEST_DATABASE_URL', () => {
    expect(
      e2eDatabaseUrl({
        [E2E_DATABASE_URL_VARIABLE]: 'postgres://e2e/y',
        [TEST_DATABASE_URL_VARIABLE]: 'postgres://test/y',
      }),
    ).toBe('postgres://e2e/y');
  });

  it('значение из файла берётся, когда в окружении пусто', () => {
    expect(e2eDatabaseUrl({}, { [E2E_DATABASE_URL_VARIABLE]: 'postgres://из-файла/y' })).toBe(
      'postgres://из-файла/y',
    );
  });

  it('без переменных падает и называет обе, а не подставляет свой адрес', () => {
    expect(() => e2eDatabaseUrl({}, {})).toThrow(/E2E_DATABASE_URL/);
    expect(() => e2eDatabaseUrl({}, {})).toThrow(/TEST_DATABASE_URL/);
    expect(() => e2eDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: '  ' }, {})).toThrow(
      /Запасного адреса нет/,
    );
  });

  it('ни одна конфигурация приёмок не подставляет адрес сама', () => {
    const files = e2eConfigFiles();
    expect(files.length).toBeGreaterThan(3);

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('postgres://nice');
    }
  });
});
