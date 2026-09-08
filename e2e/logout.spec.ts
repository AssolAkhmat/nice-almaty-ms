import { expect, test } from '@playwright/test';

import { login } from './support/login';

/**
 * Выход из системы (T9.6). До 9 сентября 2026 кнопки не было вовсе:
 * действие существовало, а вызвать его было неоткуда.
 *
 * На 375 кнопка живёт в меню «Ещё», на остальных ширинах — внизу бокового меню.
 */
test.describe('выход из системы', () => {
  test('кнопка выхода завершает сессию, и защищённая зона закрывается', async ({ page }, info) => {
    await login(page);

    if (info.project.name === 'mobile-375') {
      await page.getByTestId('nav-more').click();
    }

    await page.getByTestId('logout').filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});
