import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Экран коммунального периода (T3.7) на трёх ширинах.
 *
 * Числа распределения проверены в `src/domain/utilities.test.ts`, закрытие
 * периода — в `src/services/utilities.db-test.ts`. Здесь — что экран
 * открывается на прошлом месяце, форма строки читается, а предварительное
 * распределение показывает излишек, а не прячет его.
 */
test.describe('экран коммуналки', () => {
  test('админ видит период своего дома', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/utilities');

    const main = page.locator('main');
    await expect(main).toContainText('Коммунальные услуги');
    await expect(main).toContainText('Строки периода');
    await expect(main).toContainText('Предварительное распределение');
  });

  test('форма строки периода на месте', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/utilities');

    await expect(page.getByTestId('utility-title')).toBeVisible();
    await expect(page.getByTestId('utility-amount')).toBeVisible();
    await expect(page.getByTestId('close-period')).toBeVisible();
  });

  test('излишек округления назван и объяснён', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/utilities');

    const main = page.locator('main');
    await expect(main).toContainText('Излишек округления');
    await expect(main).toContainText('Излишек остаётся в фонде дома');
  });
});
