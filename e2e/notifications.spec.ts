import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Центр уведомлений (T6.4) на трёх ширинах.
 *
 * Проверяется каркас: список, фильтры и счётчик непрочитанного. Что именно
 * попадает в список, проверяют интеграционные тесты `notifications.db-test`;
 * здесь важно, что экран открывается, фильтры живут в адресе, а карточка
 * подписки на push честно говорит о своём состоянии.
 */
test.describe('центр уведомлений', () => {
  test('жилец открывает список и переключает фильтры', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/notifications');

    await expect(page.locator('main')).toContainText('Уведомления');
    await expect(page.getByTestId('unread-count')).toBeVisible();

    await page.getByTestId('filter-unread').click();
    await expect(page).toHaveURL(/unread=1/);

    await page.getByTestId('filter-type').selectOption('rotation.reminder');
    await expect(page).toHaveURL(/type=rotation\.reminder/);

    await page.getByTestId('filter-all').click();
    await expect(page).not.toHaveURL(/unread=1/);
  });

  test('пустой список объясняет себя, а не показывает пустоту', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/notifications?unread=1');

    await expect(page.locator('main')).toContainText('Непрочитанных нет');
  });

  test('в профиле есть карточка push и её состояние', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/profile');

    await expect(page.locator('main')).toContainText('Push на этом устройстве');

    /*
     * Ключей VAPID у прогона нет, и это не сбой: канал не настроен,
     * а экран обязан сказать это словами, а не молчать кнопкой,
     * которая ничего не делает.
     */
    await expect(page.getByTestId('push-not-configured')).toBeVisible();
  });
});
