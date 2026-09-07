import { fileURLToPath } from 'node:url';
import { chromium, defineConfig, devices } from '@playwright/test';

import { dotEnvFallback } from './scripts/read-dotenv';

/*
 * `.env` читается явно: playwright его в окружение не переносит, и прогон
 * уходил бы в базу по умолчанию — на порт локального PostgreSQL вместо
 * контейнера (инцидент I2). Заданное в оболочке сильнее файла.
 */
const fileEnv = dotEnvFallback(fileURLToPath(new URL('./.env', import.meta.url)));

const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Три ширины из docs/05-DESIGN-SYSTEM.md: 375 / 768 / 1440.
 * Каждый экран проверяется во всех трёх.
 */
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  fileEnv.E2E_DATABASE_URL ??
  fileEnv.TEST_DATABASE_URL ??
  'postgres://nice:nice@127.0.0.1:5432/nice_almaty';

export default defineConfig({
  testDir: './e2e',
  // Учётные записи для входа готовит сид: обходных путей в приложении нет.
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  /*
   * Число потоков задано, а не отдано умолчанию. С ростом набора до полутора
   * сотен проверок полная параллельность перегружала машину: падала то одна
   * проверка, то другая, каждый раз новая, а поодиночке все проходили.
   * Набор, результат которого зависит от загрузки машины, ничего не проверяет.
   *
   * Четыре потока держат прогон около трёх минут и оставляют запас на самый
   * тяжёлый шаг — печать договора, поднимающую chromium (P2-46).
   */
  workers: 4,
  /*
   * Ожидание длиннее умолчания: приёмочный сценарий идёт тремя копиями
   * сразу — по одной на ширину, — и на общей машине шаг иногда не успевает
   * за пять секунд. Это про скорость прогона, а не про поведение системы.
   */
  expect: { timeout: 15_000 },
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? [['github'], ['html', { open: 'never' }]] : [['list']],
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
    reuseExistingServer: process.env.CI !== 'true',
    timeout: 120_000,
    env: {
      DEPLOY_TARGET: 'docker',
      DATABASE_URL,
      APP_URL: BASE_URL,
      SESSION_SECRET: 'e2e-session-secret-not-a-real-secret-32',
      FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      CRON_SECRET: 'e2e-cron-secret-16',
      STORAGE_DRIVER: 'local',
      /*
       * Печать договора идёт настоящим chromium — тем же, которым playwright
       * открывает страницы. Без него шаг 5 §1.2 в приёмке не проходит,
       * а системного браузера на машине разработчика может не быть.
       */
      CHROMIUM_PATH: chromium.executablePath(),
    },
  },
});
