import { expect, test } from '@playwright/test';

const MODULE_COUNT = 12;

/*
 * Защищённая зона требует сессии, а учётных записей до сида (T1.9) нет.
 * Проверки восстанавливаются тем же коммитом, который заводит сид.
 */
test.describe.skip('адаптивная навигация', () => {
  test('раскладка соответствует ширине экрана', async ({ page }, testInfo) => {
    await page.goto('/');

    const sidebar = page.getByTestId('sidebar');
    const bottomNav = page.getByTestId('bottom-nav');

    if (testInfo.project.name === 'mobile-375') {
      // Ниже 768 бокового меню нет, работает нижняя навигация.
      await expect(sidebar).toBeHidden();
      await expect(bottomNav).toBeVisible();
      await expect(bottomNav.getByRole('link')).toHaveCount(4);
      return;
    }

    await expect(sidebar).toBeVisible();
    await expect(bottomNav).toBeHidden();
    await expect(sidebar.getByRole('link')).toHaveCount(MODULE_COUNT);

    const width = testInfo.project.use.viewport?.width ?? 0;
    const box = await sidebar.boundingBox();

    if (width >= 1024) {
      // Десктоп: постоянное меню 240px с подписями.
      expect(box?.width).toBe(240);
      await expect(sidebar.getByRole('link', { name: 'Ротации' })).toBeVisible();
    } else {
      // Планшет: меню свёрнуто в иконки.
      expect(box?.width).toBe(64);
    }
  });

  test('кнопка «Ещё» открывает полный список разделов', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Нижняя навигация только на мобильном');

    await page.goto('/');
    await page.getByTestId('nav-more').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link')).toHaveCount(MODULE_COUNT);

    await dialog.getByRole('link', { name: 'Инвентарь' }).click();
    await expect(page).toHaveURL(/\/inventory$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Инвентарь');
  });

  test('переход в раздел меняет адрес и заголовок', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-375', 'Боковое меню скрыто на мобильном');

    await page.goto('/');
    await page.getByTestId('sidebar').getByRole('link', { name: 'Счета' }).click();

    await expect(page).toHaveURL(/\/invoices$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Счета');
    await expect(page.getByTestId('sidebar').getByRole('link', { name: 'Счета' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('горизонтальной прокрутки нет ни на одной ширине', async ({ page }) => {
    await page.goto('/');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('цели нажатия в навигации не меньше 44px', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Требование касается мобильного');

    await page.goto('/');
    const items = page.getByTestId('bottom-nav').locator('a, button');
    const count = await items.count();

    for (let index = 0; index < count; index += 1) {
      const box = await items.nth(index).boundingBox();

      expect(box?.height ?? 0, `пункт ${index}`).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0, `пункт ${index}`).toBeGreaterThanOrEqual(44);
    }
  });
});
