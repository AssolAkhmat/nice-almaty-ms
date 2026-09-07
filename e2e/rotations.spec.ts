import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Календарь ротаций (T4.6) на трёх ширинах.
 *
 * Проверяется каркас экрана: три режима, ходьба по периодам и блок действий
 * админа. Что делают сами действия, проверяют интеграционные тесты
 * `rotation-calendar.db-test`.
 */
test.describe('календарь ротаций', () => {
  test('админ открывает три режима и ходит по периодам', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/rotations');

    await expect(page.locator('main')).toContainText('Ротации');
    await expect(page.getByTestId('mode-day')).toBeVisible();
    await expect(page.getByTestId('mode-week')).toBeVisible();
    await expect(page.getByTestId('mode-month')).toBeVisible();

    await page.getByTestId('mode-day').click();
    await expect(page).toHaveURL(/mode=day/);

    await page.getByTestId('calendar-next').click();
    await expect(page).toHaveURL(/date=/);

    await page.getByTestId('calendar-today').click();
    await expect(page).toHaveURL(/mode=day/);
  });

  test('в дневном режиме есть текст для группы с кнопкой «Копировать»', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/rotations?mode=day');

    await expect(page.getByTestId('day-template-text')).toBeVisible();
    await expect(page.getByTestId('day-template-copy')).toBeVisible();

    // Текст plain text и всегда содержит дату дня: её же показывает заголовок.
    const text = await page.getByTestId('day-template-text').inputValue();
    expect(text).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  test('в недельном режиме текста для группы нет: непонятно, какой день копировать', async ({
    page,
  }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/rotations?mode=week');

    await expect(page.getByTestId('day-template-text')).toHaveCount(0);
  });

  test('админ видит действия над периодом, если у дома есть зоны с чек-листами', async ({
    page,
  }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/rotations');

    const main = page.locator('main');

    // Блок появляется только у дома с чек-листами: без них внеплановую
    // ротацию назначать не на что, и форма честно отсутствует.
    const hasPeriodActions = await page.getByTestId('extra-form').count();
    if (hasPeriodActions > 0) {
      await expect(page.getByTestId('holidays-form')).toBeVisible();
    } else {
      await expect(main).toContainText('Ротаций на этот период нет');
    }
  });
});
