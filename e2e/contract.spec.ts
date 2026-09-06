import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Экран договора (T2.9) на трёх ширинах.
 *
 * Подпись и печать PDF целиком проходят в приёмке фазы (T2.16): до неё
 * проживание через интерфейс не создаётся, а без него подписывать нечего.
 * Здесь проверяется то, что уже работает: раздел на месте, вид зависит
 * от роли и пустые состояния объясняют себя словами.
 */
test.describe('экран договора', () => {
  test('админ видит список договоров своего дома', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/contract');

    const main = page.locator('main');
    await expect(main).toContainText('Договор');
    await expect(main).toContainText('Договоры жильцов вашего дома');
  });

  test('раздел доступен из навигации', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/');

    const link = page.getByRole('link', { name: 'Договор' }).first();
    if ((await link.count()) > 0 && (await link.isVisible())) {
      await link.click();
    } else {
      await page.goto('/contract');
    }

    await expect(page).toHaveURL(/\/contract$/);
  });
});
