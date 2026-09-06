import { expect, test } from '@playwright/test';

test.describe('язык интерфейса', () => {
  test('по умолчанию русский', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Дэшборд');
  });

  test('переключается на казахский и английский и переживает перезагрузку', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('locale-switcher').selectOption('kk');
    await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Бақылау тақтасы');

    await page.getByTestId('locale-switcher').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
  });

  test('в интерфейсе нет непереведённых ключей', async ({ page }) => {
    for (const locale of ['ru', 'kk', 'en']) {
      await page.goto('/');
      await page.getByTestId('locale-switcher').selectOption(locale);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);

      const text = await page.locator('body').innerText();
      expect(text, `локаль ${locale}`).not.toMatch(/nav\.|common\.|app\./);
    }
  });
});
