import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';
import { unique } from './support/onboarding';

/**
 * Инвентарь (T6.10, T6.11) на трёх ширинах.
 *
 * Приход, списание и инвентаризация проходят через экран целиком:
 * что считает система, проверяют интеграционные тесты `inventory.db-test`
 * и `inventory-audit.db-test`.
 */
test.describe('инвентарь', () => {
  test('админ принимает позицию на учёт и списывает часть', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/inventory');

    const name = unique('Краска');

    await page.getByTestId('item-name').fill(name);
    await page.getByTestId('item-qty').fill('12.50');
    await page.getByTestId('item-unit').fill('л');
    await page.getByTestId('item-cost').fill('3500');
    await page.getByTestId('item-add').click();

    const list = page.getByTestId('inventory-list');
    await expect(list).toContainText(name);
    await expect(list).toContainText('12.50');

    const row = list.locator('li').filter({ hasText: name });
    await row.getByRole('textbox').first().fill('2.50');
    await row.getByRole('button', { name: 'Списать', exact: true }).click();

    await expect(list.locator('li').filter({ hasText: name })).toContainText('10.00');
  });

  test('ведомость сверяет учёт с фактом и закрывается корректировкой', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse2);
    await page.goto('/inventory');

    const name = unique('Швабра');

    await page.getByTestId('item-name').fill(name);
    await page.getByTestId('item-qty').fill('5');
    await page.getByTestId('item-unit').fill('шт');
    await page.getByTestId('item-cost').fill('2000');
    await page.getByTestId('item-add').click();
    await expect(page.getByTestId('inventory-list')).toContainText(name);

    const panel = page.getByTestId('audit-panel');

    if (await panel.getByTestId('audit-start').isVisible()) {
      await panel.getByTestId('audit-start').click();
    }

    const line = panel.locator('form').filter({ hasText: name });
    await line.getByRole('textbox').first().fill('4');
    await line.getByRole('button', { name: 'Сохранить' }).click();

    await expect(panel.locator('form').filter({ hasText: name })).toContainText('-1.00');

    await panel.getByTestId('audit-close').click();

    await expect(
      page.getByTestId('inventory-list').locator('li').filter({ hasText: name }),
    ).toContainText('4.00');
  });

  test('выгрузка отдаёт файл, а не страницу', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/inventory');

    const link = page.getByTestId('export-csv');
    const href = await link.getAttribute('href');
    expect(href).toContain('/api/v1/inventory/export');

    const response = await page.request.get(href ?? '');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');
    expect(await response.text()).toContain('Наименование;Количество');
  });
});
