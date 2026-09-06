import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { dotEnvFallback } from './scripts/read-dotenv';

/**
 * Интеграционные тесты на настоящем PostgreSQL. Отдельно от `pnpm test`,
 * чтобы быстрый прогон не требовал поднятой базы. В CI выполняются
 * в job с сервисом postgres, после применения миграций.
 *
 * `.env` читается явно: сам vitest его в `process.env` не переносит,
 * и без этого прогон уходил в чужую базу (инцидент I2).
 */
const env = dotEnvFallback(fileURLToPath(new URL('./.env', import.meta.url)));

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
