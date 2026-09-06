import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Интеграционные тесты на настоящем PostgreSQL. Отдельно от `pnpm test`,
 * чтобы быстрый прогон не требовал поднятой базы. В CI выполняются
 * в job с сервисом postgres, после применения миграций.
 *
 * `.env` читается здесь явно: сам vitest в `process.env` его не переносит,
 * и без этого прогон уходил в базу по умолчанию — на порт локального
 * PostgreSQL вместо контейнера, а ключ шифрования полей отсутствовал вовсе.
 * Заданное в оболочке значение важнее файла: в CI адрес базы приходит
 * именно так, и файл не должен его перекрывать.
 */
function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const values: Record<string, string> = {};

  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');

    // Пустая строка — не значение: на этом в фазе 0 падал drizzle-kit.
    if (value !== '') {
      values[key] = value;
    }
  }

  return values;
}

const fromFile = readDotEnv(fileURLToPath(new URL('./.env', import.meta.url)));

const env = Object.fromEntries(
  Object.entries(fromFile).filter(([key]) => process.env[key] === undefined),
);

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.db-test.ts'],
    env,
    // Транзакции на одном соединении: параллельные файлы мешали бы друг другу.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
