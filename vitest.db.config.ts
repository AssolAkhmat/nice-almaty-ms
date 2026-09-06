import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Интеграционные тесты на настоящем PostgreSQL. Отдельно от `pnpm test`,
 * чтобы быстрый прогон не требовал поднятой базы. В CI выполняются
 * в job с сервисом postgres, после применения миграций.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.db-test.ts'],
    // Транзакции на одном соединении: параллельные файлы мешали бы друг другу.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
