import { expect, test, type Page } from '@playwright/test';

import { SUPERADMIN_PHONE } from '../src/db/seed';
import { NAV_ITEMS } from '../src/lib/navigation';

import { E2E_EMPTY_PASSWORD } from './global-setup';

/**
 * Первый день системы (T9.13): ничего ещё не заведено. Дэшборд без домов,
 * бухгалтерия без счетов, дом без комнат, жилец без места — каждый экран
 * каждой роли обязан открыться, а не упасть серверной ошибкой.
 *
 * Проверяется не содержимое, а живость: ответ не 5xx, на странице нет
 * страницы ошибки, есть заголовок. Перенаправление закрытого раздела
 * на дэшборд — нормальный исход, падение — нет.
 */
const SETTINGS_PAGES = [
  '/settings/users',
  '/settings/houses',
  '/settings/network',
  '/settings/document-types',
  '/settings/accounts',
  '/settings/contract-template',
  '/settings/rating',
  '/settings/api-tokens',
  '/settings/audit',
  '/settings/personal',
] as const;

const HOUSE_PAGES = [
  '/settings/house',
  '/settings/house/rotations',
  '/settings/personal',
  '/rotations/stats',
  '/invoices/remote',
] as const;

const MODULE_PAGES = NAV_ITEMS.map((item) => item.href as string);

const NEW_PASSWORD = 'parol-pervogo-dnya';

function uniquePhone(): string {
  return `+7709${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
}

async function signIn(
  page: Page,
  phone: string,
  password: string,
  options: { temporary?: boolean } = {},
): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByTestId('phone').fill(phone);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('submit').click();

  // Вход — переход на сервере: дальше идти можно только после его завершения.
  if (options.temporary === true) {
    await expect(page).toHaveURL(/\/change-password$/);
    return;
  }

  await expect(page.getByTestId('sidebar')).toBeAttached();
}

/** Экран жив: ответ не серверная ошибка, страницы ошибки нет, заголовок на месте. */
async function expectAlive(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);

  expect(response?.status(), `${path}: статус ответа`).toBeLessThan(500);

  const body = await page.locator('body').innerText();
  expect(body, `${path}: страница ошибки`).not.toMatch(/Application error|Internal Server Error/);

  await expect(page.getByRole('heading', { level: 1 }).first(), `${path}: заголовок`).toBeVisible();
}

/** Суперадмин заводит учётную запись, человек меняет временный пароль. */
async function createAccount(
  page: Page,
  role: 'admin' | 'resident',
  houseName: string,
): Promise<string> {
  const phone = uniquePhone();

  await signIn(page, SUPERADMIN_PHONE, E2E_EMPTY_PASSWORD);
  await page.goto('/settings/users');
  await page.getByTestId('new-phone').fill(phone);
  await page.getByTestId('new-role').selectOption(role);
  await page.getByTestId('new-house').selectOption({ label: houseName });
  await page.getByTestId('create-submit').click();

  await expect(page.getByTestId('temporary-password')).toBeVisible();
  const temporary = (await page.getByTestId('temporary-password-value').innerText()).trim();

  await signIn(page, phone, temporary, { temporary: true });
  await page.getByTestId('new-password').fill(NEW_PASSWORD);
  await page.getByTestId('confirmation').fill(NEW_PASSWORD);
  await page.getByTestId('submit').click();
  await expect(page).toHaveURL(/\/login/);

  return phone;
}

async function createHouse(page: Page, name: string): Promise<void> {
  await signIn(page, SUPERADMIN_PHONE, E2E_EMPTY_PASSWORD);
  await page.goto('/settings/houses');
  await page.getByTestId('new-house-name').fill(name);
  await page.getByTestId('create-house-submit').click();
  await expect(page.locator('main')).toContainText(name);
}

test.describe('пустая база', () => {
  test('суперадмин сети без домов открывает каждый раздел', async ({ page }) => {
    await signIn(page, SUPERADMIN_PHONE, E2E_EMPTY_PASSWORD);
    await expect(page.getByTestId('sidebar')).toBeAttached();

    for (const path of [
      ...MODULE_PAGES,
      ...SETTINGS_PAGES,
      '/rotations/stats',
      '/invoices/remote',
    ]) {
      await expectAlive(page, path);
    }
  });

  test('админ дома без комнат и жильцов открывает каждый раздел', async ({ page }, info) => {
    const house = `Пустой дом ${info.project.name}`;
    await createHouse(page, house);
    const phone = await createAccount(page, 'admin', house);

    await signIn(page, phone, NEW_PASSWORD);
    await expect(page.getByTestId('sidebar')).toBeAttached();

    for (const path of [...MODULE_PAGES, ...HOUSE_PAGES]) {
      await expectAlive(page, path);
    }
  });

  test('жилец без места открывает каждый раздел', async ({ page }, info) => {
    const house = `Дом жильца ${info.project.name}`;
    await createHouse(page, house);
    const phone = await createAccount(page, 'resident', house);

    await signIn(page, phone, NEW_PASSWORD);
    await expect(page.getByTestId('sidebar')).toBeAttached();

    for (const path of [...MODULE_PAGES, '/profile', '/settings/personal']) {
      await expectAlive(page, path);
    }
  });
});
