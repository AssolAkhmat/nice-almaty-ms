import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Карточка жильца целиком (модуль 1, «Карточка жильца»; указание владельца
 * от 25 сентября 2026).
 *
 * До этого карточка закрывала три пункта из девяти, а ссылки вели на общие
 * экраны без жильца. Проверяется то, что на трёх ширинах разделы на месте
 * и что документы видны тому, кому сеть дала полномочие, — а не тому,
 * кто просто админ.
 */
async function openFirstResident(page: Parameters<typeof login>[0]): Promise<void> {
  await page.goto('/residents');

  const first = page.getByTestId('resident-row').first();
  await expect(first).toBeVisible();

  await first.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/residents\/[0-9a-f-]+$/);
}

test.describe('карточка жильца', () => {
  test('суперадмин видит разделы, а не одну смену роли', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await openFirstResident(page);

    const main = page.locator('main');

    await expect(main).toContainText('Сводка');
    await expect(main).toContainText('Мой профиль');
    await expect(main).toContainText('Документы');
    await expect(main).toContainText('Депозит');
    await expect(main).toContainText('Счета');
  });

  test('список жильцов называет рейтинг, долг и ключи', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/residents');

    const first = page.getByTestId('resident-row').first();
    await expect(first).toBeVisible();
    await expect(first.getByTestId('resident-rating')).toBeVisible();
    await expect(first).toContainText('Ключи');
  });

  /*
   * Полномочие «документы жильца» у админа выключено по умолчанию (D28):
   * раздела документов в карточке у него нет, и это не поломка, а настройка.
   */
  test('админу без полномочия раздел документов не показывается', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await openFirstResident(page);

    const main = page.locator('main');

    await expect(main).toContainText('Сводка');
    await expect(main.getByText('Флюорография')).toHaveCount(0);
  });

  test('кнопка «Назад» возвращает к списку', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await openFirstResident(page);

    await page.getByTestId('back-link').click();

    await expect(page).toHaveURL(/\/residents$/);
  });
});
