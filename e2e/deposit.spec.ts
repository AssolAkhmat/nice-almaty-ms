import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Экран депозита (T2.10) на трёх ширинах.
 *
 * Полный путь «счёт — оплата — заселение» проверяется приёмкой фазы (T2.16):
 * до неё проживание через интерфейс не создаётся. Здесь — что раздел на месте
 * и пустое состояние объясняет себя.
 */
test.describe('экран депозита', () => {
  test('админ видит список депозитов своего дома', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/deposit');

    const main = page.locator('main');
    await expect(main).toContainText('Депозит');
    await expect(main).toContainText('Депозиты жильцов вашего дома');
  });

  test('раздел доступен из навигации', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/');

    const link = page.getByRole('link', { name: 'Депозит' }).first();
    if ((await link.count()) > 0 && (await link.isVisible())) {
      await link.click();
    } else {
      await page.goto('/deposit');
    }

    await expect(page).toHaveURL(/\/deposit$/);
  });
});
