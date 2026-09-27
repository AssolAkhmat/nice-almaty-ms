import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Бухгалтерия (T3.9) на трёх ширинах.
 *
 * Арифметика калькулятора проверена числами в `src/domain/tax.test.ts`,
 * проводки расхода — в `src/services/accounting.db-test.ts`. Здесь —
 * что раздел открыт суперадмину и закрыт админу дома, и что надпись
 * о справочности расчёта стоит на экране, как требует §10.2.
 */
test.describe('экран бухгалтерии', () => {
  test('суперадмин видит ведомость, сверку и калькулятор', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/accounting');

    const main = page.locator('main');
    await expect(main).toContainText('Оборотная ведомость');
    await expect(main).toContainText('Сверка депозитного фонда');
    await expect(main).toContainText('Калькулятор налогов');
  });

  test('надпись о справочности расчёта стоит на экране (§10.2)', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/accounting');

    await expect(page.locator('main')).toContainText(
      'Расчёт справочный, проводок не создаёт и налоговой консультацией не является',
    );
  });

  test('ставки видны и редактируются', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/accounting');

    await expect(page.getByTestId('tax-rate')).toHaveValue('3.00');
    await expect(page.getByTestId('tax-result')).toBeVisible();
  });

  test('админу дома книга проводок не открывается (§10.1)', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/accounting');

    const main = page.locator('main');
    await expect(main).toContainText('Раздел для суперадмина');
    await expect(main).not.toContainText('Оборотная ведомость');
  });

  /*
   * Находка боевой эксплуатации P0-2 (27 сентября 2026): админ дома видел
   * раздел бухгалтерии в меню. Роут отказывал, но пункт показывался всем —
   * список разделов не спрашивал прав вовсе. Скрытая ссылка на закрытый роут
   * исправлением не считается, поэтому проверяется и меню, и роут.
   */
  test('ссылки на бухгалтерию нет в меню админа дома', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/');

    await expect(page.locator('a[href="/accounting"]')).toHaveCount(0);
    /* Раздел, который админу положен, в меню остаётся. */
    await expect(page.locator('a[href="/inventory"]').first()).toBeAttached();
  });

  test('у суперадмина ссылка на бухгалтерию в меню есть', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/');

    await expect(page.locator('a[href="/accounting"]').first()).toBeAttached();
  });
});
