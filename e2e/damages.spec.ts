import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Экран ущерба (T3.4) на трёх ширинах.
 *
 * Полный путь «ущерб — списание с депозита — движение у жильца» проверяется
 * приёмкой фазы (T3.10). Здесь — что раздел на месте, форма деления читается
 * и предпросмотр не показывает сумм, пока делить не с кого.
 */
test.describe('экран ущерба', () => {
  test('админ видит форму проведения ущерба', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/damages');

    const main = page.locator('main');
    await expect(main).toContainText('Ущерб');
    await expect(main).toContainText('Ремонт за счёт депозитов жильцов');
    await expect(page.getByTestId('damage-title')).toBeVisible();
    await expect(page.getByTestId('damage-mode')).toBeVisible();
  });

  test('режим деления выбирается всеми пятью способами (§8)', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/damages');

    const mode = page.getByTestId('damage-mode');
    const options = await mode.locator('option').allTextContents();

    expect(options).toEqual([
      'Один человек',
      'По комнате',
      'Все жильцы дома',
      'Все, кроме выбранных',
      'Произвольный список',
    ]);
  });

  test('без суммы предпросмотр не показывает долей', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/damages');

    await expect(page.getByTestId('damage-preview')).toHaveCount(0);
    await expect(page.locator('main')).toContainText('Укажите сумму и участников');
  });
});
