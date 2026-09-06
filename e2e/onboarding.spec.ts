import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Мастер заселения и жёсткая блокировка (§1.2).
 *
 * Пока депозит не оплачен, жильцу закрыты ротации, отсутствия, места
 * и прочие модули. Проверяется именно это: не «кнопки не видно»,
 * а прямая ссылка не открывается.
 */
function uniquePhone(): string {
  const digits = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');

  return `+7708${digits}`;
}

async function createResidentAndLogin(page: Page): Promise<void> {
  const phone = uniquePhone();

  await login(page, E2E_ACCOUNTS.superadmin);
  await page.goto('/settings/users');
  await page.getByTestId('new-phone').fill(phone);
  await page.getByTestId('new-role').selectOption('resident');
  await page.getByTestId('create-submit').click();

  await expect(page.getByTestId('temporary-password')).toBeVisible();
  const temporary = (await page.getByTestId('temporary-password-value').innerText()).trim();

  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByTestId('phone').fill(phone);
  await page.getByTestId('password').fill(temporary);
  await page.getByTestId('submit').click();

  await expect(page).toHaveURL(/\/change-password$/);

  const password = 'parol-zhiltsa-zaselenie';
  await page.getByTestId('new-password').fill(password);
  await page.getByTestId('confirmation').fill(password);
  await page.getByTestId('submit').click();

  await expect(page).toHaveURL(/\/login/);
  await page.getByTestId('phone').fill(phone);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sidebar')).toBeAttached();
}

test.describe('заселение', () => {
  test('незаселённый жилец видит мастер на дэшборде', async ({ page }) => {
    await createResidentAndLogin(page);
    await page.goto('/');

    const wizard = page.getByTestId('onboarding-wizard');
    await expect(wizard).toBeVisible();
    await expect(wizard).toContainText('Профиль заполнен');
    await expect(wizard).toContainText('Депозит оплачен');
  });

  test('закрытые модули не открываются по прямой ссылке', async ({ page }) => {
    await createResidentAndLogin(page);

    for (const path of ['/rotations', '/absences', '/beds', '/rating']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
    }
  });

  test('профиль, документы и договор остаются открытыми', async ({ page }) => {
    await createResidentAndLogin(page);

    await page.goto('/profile');
    await expect(page).toHaveURL(/\/profile$/);

    await page.goto('/documents');
    await expect(page).toHaveURL(/\/documents$/);

    await page.goto('/contract');
    await expect(page).toHaveURL(/\/contract$/);
  });

  test('админа блокировка не касается', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);

    await page.goto('/rotations');
    await expect(page).toHaveURL(/\/rotations$/);
  });
});
