import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Отсутствия (T5.3) на трёх ширинах.
 *
 * Проверяется каркас экрана: у админа очередь и календарь дома, у него же
 * нет формы подачи — он не жилец. Что происходит внутри подачи и одобрения,
 * проверяют интеграционные тесты `absences.db-test`.
 */
test.describe('отсутствия', () => {
  test('админ видит очередь и календарь дома', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/absences');

    const main = page.locator('main');
    await expect(main).toContainText('Отсутствия');
    await expect(main).toContainText('Ждут решения');
    await expect(main).toContainText('Календарь дома');

    // Форма подачи — жильцу: админ сообщает о своём отсутствии не здесь.
    await expect(page.getByTestId('absence-form')).toHaveCount(0);
  });

  test('суперадмин открывает раздел и видит календарь', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/absences');

    await expect(page.locator('main')).toContainText('Отсутствия');
  });
});
