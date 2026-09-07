import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Экраны рейтинга (T5.8) на трёх ширинах.
 *
 * Здесь — каркас: раздел открывается и показывает то, что положено роли.
 * Что видит жилец и что происходит со штрафом, проверяет приёмка фазы:
 * там сценарий сам заводит жильца, а не надеется на чужой прогон.
 */
test.describe('рейтинг', () => {
  test('админ видит рейтинг дома, но не форму своего числа', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/rating');

    const main = page.locator('main');
    await expect(main).toContainText('Рейтинг');

    // Админ дома в нём не живёт: своего числа у него нет.
    await expect(page.getByTestId('my-rating')).toHaveCount(0);
  });

  test('суперадмин открывает раздел', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/rating');

    await expect(page.locator('main')).toContainText('Рейтинг');
  });
});
