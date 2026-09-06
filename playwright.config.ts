import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Три ширины из docs/05-DESIGN-SYSTEM.md: 375 / 768 / 1440.
 * Каждый экран проверяется во всех трёх.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
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
      DATABASE_URL: 'postgres://nice:nice@127.0.0.1:5432/nice_almaty',
      APP_URL: BASE_URL,
      SESSION_SECRET: 'e2e-session-secret-not-a-real-secret-32',
      FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      CRON_SECRET: 'e2e-cron-secret-16',
      STORAGE_DRIVER: 'local',
    },
  },
});
