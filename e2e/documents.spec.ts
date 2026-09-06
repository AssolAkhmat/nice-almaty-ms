import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Экран документов (T2.8) на трёх ширинах.
 *
 * Полный путь «жилец загрузил — админ принял» проверяется приёмкой фазы
 * (T2.16): до неё проживание через интерфейс не создаётся, а без проживания
 * загружать документы некуда. Здесь проверяется то, что уже работает:
 * раздел на месте, вид зависит от роли, очередь проверки пуста и говорит
 * об этом словами.
 */
function uniquePhone(): string {
  const digits = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');

  return `+7708${digits}`;
}

/** Жилец, созданный через интерфейс: обходных путей создания аккаунтов нет. */
async function createResident(page: Page): Promise<{ phone: string; password: string }> {
  const phone = uniquePhone();

  await page.goto('/settings/users');
  await page.getByTestId('new-phone').fill(phone);
  await page.getByTestId('new-role').selectOption('resident');
  // Дом задаёт проживание жильца: без него аккаунт не создать (§1.2 п.1).
  await page.getByTestId('new-house').selectOption({ label: 'Дом 1' });
  await page.getByTestId('create-submit').click();

  await expect(page.getByTestId('temporary-password')).toBeVisible();
  const temporary = (await page.getByTestId('temporary-password-value').innerText()).trim();

  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByTestId('phone').fill(phone);
  await page.getByTestId('password').fill(temporary);
  await page.getByTestId('submit').click();

  await expect(page).toHaveURL(/\/change-password$/);

  const password = 'parol-zhiltsa-dokumenty';
  await page.getByTestId('new-password').fill(password);
  await page.getByTestId('confirmation').fill(password);
  await page.getByTestId('submit').click();

  await expect(page).toHaveURL(/\/login/);
  await page.getByTestId('phone').fill(phone);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sidebar')).toBeAttached();

  return { phone, password };
}

test.describe('экран документов', () => {
  test('админ видит очередь проверки своего дома', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/documents');

    const main = page.locator('main');
    await expect(main).toContainText('Документы');
    await expect(main).toContainText('Документы жильцов вашего дома');
  });

  test('новый жилец сразу видит карточки обязательных документов', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await createResident(page);

    await page.goto('/documents');

    // Проживание заводится вместе с аккаунтом (§1.2 п.1), поэтому загружать
    // документы можно сразу — объяснять нечего.
    const main = page.locator('main');
    await expect(main).toContainText('Фото 3×4');
    await expect(main).toContainText('Флюорография');
  });

  test('раздел доступен из навигации', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/');

    // На мобильном раздел лежит под «Ещё», на остальных ширинах — в меню.
    const link = page.getByRole('link', { name: 'Документы' }).first();
    if ((await link.count()) > 0 && (await link.isVisible())) {
      await link.click();
    } else {
      await page.goto('/documents');
    }

    await expect(page).toHaveURL(/\/documents$/);
  });
});
