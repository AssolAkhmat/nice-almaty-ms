import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Экран «удалёнки» (T3.8) на трёх ширинах.
 *
 * Отбор по способу оплаты и отметка отправки проверены на живой базе
 * в `src/services/remote.db-test.ts`. Здесь — что раздел открывается
 * из списка счетов и объясняет себя, когда задач нет.
 */
test.describe('экран удалёнки', () => {
  test('открывается по ссылке из списка счетов', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/invoices');

    await page.getByRole('link', { name: 'Удалёнка' }).click();

    await expect(page).toHaveURL(/\/invoices\/remote$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Удалёнка');
  });

  test('пустое состояние объясняет, кто сюда попадает', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/invoices/remote');

    const main = page.locator('main');

    if ((await page.getByTestId('remote-task').count()) === 0) {
      await expect(main).toContainText('жильцы с оплатой через Kaspi');
      return;
    }

    await expect(page.getByTestId('remote-received').first()).toBeVisible();
  });
});
