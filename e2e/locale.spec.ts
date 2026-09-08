import { expect, test } from '@playwright/test';

import { createResident, RESIDENT_PASSWORD, signInAs } from './support/onboarding';

test.describe('язык интерфейса', () => {
  /*
   * Инцидент I14: у вошедшего язык читается из учётной записи, а переключатель
   * писал только cookie — интерфейс оставался русским. Аккаунт свой:
   * язык хранится в учётной записи, и переключение сидового суперадмина
   * сломало бы приёмки, идущие в это же время.
   */
  test('вошедший переключает язык, и выбор переживает перезагрузку', async ({ page }) => {
    const phone = await createResident(page, 'Дом 1');
    await signInAs(page, phone, RESIDENT_PASSWORD);

    await page.goto('/profile');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

    await page.getByTestId('locale-switcher').selectOption('kk');
    await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
    await expect(page.getByTestId('locale-switcher')).toHaveValue('kk');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'kk');

    await page.getByTestId('locale-switcher').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My profile');
  });

  test('по умолчанию русский', async ({ page }) => {
    await page.goto('/login');

    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Вход');
  });

  test('переключается на казахский и английский и переживает перезагрузку', async ({ page }) => {
    await page.goto('/login');

    await page.getByTestId('locale-switcher').selectOption('kk');
    await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Кіру');

    await page.getByTestId('locale-switcher').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  });

  test('в интерфейсе нет непереведённых ключей', async ({ page }) => {
    for (const locale of ['ru', 'kk', 'en']) {
      await page.goto('/login');
      await page.getByTestId('locale-switcher').selectOption(locale);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);

      const text = await page.locator('body').innerText();
      expect(text, `локаль ${locale}`).not.toMatch(/nav\.|common\.|app\./);
    }
  });
});
