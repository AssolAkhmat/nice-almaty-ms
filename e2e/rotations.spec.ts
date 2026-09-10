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

  test('статистика открывается из календаря и показывает своды', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/rotations');

    await page.getByTestId('to-stats').click();

    const main = page.locator('main');
    await expect(main).toContainText('Статистика ротаций');
    await expect(main).toContainText('По жильцам');
    await expect(main).toContainText('По зонам');
    await expect(main).toContainText('По дням недели');
    await expect(main).toContainText('По месяцам');
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
      // Галочка «списать доп. ротацию» у внеплановой (§7, фаза 10 §2.7).
      await expect(page.getByTestId('extra-writeoff')).toBeVisible();
    } else {
      await expect(main).toContainText('Ротаций на этот период нет');
    }
  });

  test('у запланированной ротации есть «поставить на зону» с галочкой списания', async ({
    page,
  }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/rotations?mode=week');

    // Форма стоит у каждого запланированного занятия (фаза 10 §2.7); что она
    // делает, проверяет `rotation-calendar.db-test`. Нет запланированных —
    // нет и формы: иначе админ ставил бы людей в историю.
    const forms = page.locator('[data-testid^="place-form-"]');
    const scheduled = page
      .locator('[data-testid^="occurrence-"]')
      .filter({ hasText: 'Запланирована' });

    if ((await forms.count()) > 0) {
      const form = forms.first();
      await expect(form.locator('[data-testid^="place-select-"]')).toBeVisible();
      await expect(form.locator('[data-testid^="place-writeoff-"]')).toBeVisible();
      await expect(form.locator('[data-testid^="place-save-"]')).toBeVisible();
    } else {
      await expect(scheduled).toHaveCount(0);
    }
  });
});
