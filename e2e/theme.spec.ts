import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'nice-almaty-theme';

test.describe('тема оформления', () => {
  test('переключается и переживает перезагрузку', async ({ page }) => {
    await page.goto('/login');

    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByTestId('theme-light').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  test('сохранённая тёмная тема применяется до отрисовки', async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key ?? '', value ?? '');
      },
      [STORAGE_KEY, 'dark'],
    );

    // Скрипт в <head> обязан проставить класс до того, как страница отрисуется,
    // иначе выбравшие тёмную тему увидят вспышку светлого фона.
    await page.goto('/login', { waitUntil: 'commit' });
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('системный режим следует за настройкой ОС', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/login');

    await page.getByTestId('theme-system').click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  test('фон и текст берутся из токенов темы', async ({ page }) => {
    await page.goto('/login');

    await page.getByTestId('theme-light').click();
    const lightBackground = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );

    await page.getByTestId('theme-dark').click();
    const darkBackground = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );

    expect(lightBackground).toBe('rgb(255, 255, 255)');
    expect(darkBackground).toBe('rgb(11, 15, 23)');
  });
});
