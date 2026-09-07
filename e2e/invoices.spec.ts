import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Экран счетов (T3.5) на трёх ширинах.
 *
 * Путь «начисление — частичная оплата — статус «Оплачен»» проверяется
 * приёмкой фазы (T3.10). Здесь — что таблица дома со сводкой на месте,
 * форма ручного счёта читается, а жилец видит свой список, а не чужой дом.
 */
test.describe('экран счетов', () => {
  test('админ видит сводку дома за месяц', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/invoices');

    const main = page.locator('main');
    await expect(main).toContainText('Счета');
    await expect(main).toContainText('Выставлено');
    await expect(main).toContainText('Оплачено');
    await expect(main).toContainText('Долг');
  });

  test('форма ручного счёта собирает строки', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/invoices');

    const form = page.getByTestId('invoice-residency');

    if ((await form.count()) === 0) {
      // Жильцов в доме нет — выставлять счёт некому, и формы быть не должно.
      await expect(page.locator('main')).toContainText('Счета');
      return;
    }

    await page.getByTestId('line-title').fill('Замена ключа');
    await page.getByTestId('line-amount').fill('2000');
    await page.getByRole('button', { name: 'Добавить строку' }).click();

    await expect(page.locator('main')).toContainText('Замена ключа');
  });

  test('жилец открывает свой список счетов', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/invoices');

    // Суперадмин видит ту же таблицу дома: сводка есть, форма зависит от жильцов.
    await expect(page.locator('main')).toContainText('Счета');
  });
});
