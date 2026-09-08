import { fileURLToPath } from 'node:url';
import { chromium, defineConfig, devices } from '@playwright/test';

import { emptyDatabaseUrl } from './e2e-empty/global-setup';
import { dotEnvFallback } from './scripts/read-dotenv';

/*
 * Приёмка на пустой базе (T9.13): первый день системы — сеть без домов,
 * дом без комнат и жильцов, жилец без места. Каждый экран каждой роли
 * обязан открыться, а не упасть серверной ошибкой.
 *
 * База своя, а не общая с основной приёмкой: та стартует с одиннадцатью
 * домами, и «пусто» в ней не наступает никогда. Пустая база пересоздаётся
 * перед каждым прогоном (`e2e-empty/global-setup.ts`), сервер поднимается
 * отдельный — на своём порту и со своей строкой подключения.
 *
 * `.env` читается явно, как и в основной конфигурации: playwright его
 * в окружение не переносит (инцидент I2).
 */
dotEnvFallback(fileURLToPath(new URL('./.env', import.meta.url)));

const PORT = Number(process.env.E2E_EMPTY_PORT ?? 3211);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e-empty',
  globalSetup: './e2e-empty/global-setup.ts',
  fullyParallel: true,
  workers: 3,
  expect: { timeout: 15_000 },
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? [['github'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './test-results-empty',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'mobile-375',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 667 } },
    },
    {
      name: 'tablet-768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm start --port ${PORT}`,
    url: BASE_URL,
    // Сервер обязан смотреть в пустую базу: чужой на этом порту не подходит.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DEPLOY_TARGET: 'docker',
      DATABASE_URL: emptyDatabaseUrl(),
      APP_URL: BASE_URL,
      SESSION_SECRET: 'e2e-session-secret-not-a-real-secret-32',
      FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      CRON_SECRET: 'e2e-cron-secret-16',
      STORAGE_DRIVER: 'local',
      CHROMIUM_PATH: chromium.executablePath(),
    },
  },
});
