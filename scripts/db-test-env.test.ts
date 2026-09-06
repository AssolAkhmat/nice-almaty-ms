import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import dbConfig from '../vitest.db.config';

/**
 * Сторож окружения интеграционных тестов.
 *
 * `pnpm test:db` читал адрес базы из `process.env`, куда `.env` никто
 * не переносил: vitest этого не делает. Прогон молча уходил на порт
 * локального PostgreSQL и падал на аутентификации, а ключ шифрования
 * полей отсутствовал вовсе — ровно та же ловушка, что и в инциденте I1,
 * только с обратным знаком: там окружение перекрывало файл, здесь файла
 * не было вовсе.
 *
 * Правило: значения из `.env` попадают в прогон, а заданные в оболочке
 * остаются сильнее файла.
 */
const REPO_ROOT = join(import.meta.dirname, '..');
const ENV_FILE = join(REPO_ROOT, '.env');

function configEnv(): Record<string, string> {
  return (dbConfig as { test?: { env?: Record<string, string> } }).test?.env ?? {};
}

function fileKeys(): string[] {
  return (
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .filter((line) => line.includes('='))
      // Пустое значение значением не считается — его и переносить нечего.
      .filter((line) => line.slice(line.indexOf('=') + 1).trim() !== '')
      .map((line) => line.slice(0, line.indexOf('=')).trim())
      .filter((key) => key !== '')
  );
}

describe('окружение интеграционных тестов', () => {
  it.skipIf(!existsSync(ENV_FILE))(
    'каждый ключ из .env попадает в прогон db-тестов или уже задан в оболочке',
    () => {
      const env = configEnv();

      for (const key of fileKeys()) {
        expect(env[key] ?? process.env[key], `переменная ${key}`).toBeDefined();
      }
    },
  );

  it('значение из оболочки сильнее файла', () => {
    const env = configEnv();
    const overridden = Object.keys(env).filter((key) => process.env[key] !== undefined);

    expect(overridden).toEqual([]);
  });
});
