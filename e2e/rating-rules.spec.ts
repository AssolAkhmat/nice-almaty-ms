import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Редактор правил рейтинга (T5.7) на трёх ширинах.
 *
 * Правила правит суперадмин: уровень сети и переопределение дома. Что
 * происходит с самими дельтами, проверяют интеграционные тесты
 * `rating-rules.db-test`; здесь — что экран открывается и сохраняет.
 */
/** Дом на каждую ширину свой: прогоны идут параллельно и правят один код. */
const HOUSE_BY_PROJECT: Record<string, string> = {
  'mobile-375': 'Дом 6',
  'tablet-768': 'Дом 7',
  'desktop-1440': 'Дом 8',
};

test.describe('правила рейтинга', () => {
  test('суперадмин правит правило дома, не трогая сеть', async ({ page }, testInfo) => {
    const houseName = HOUSE_BY_PROJECT[testInfo.project.name] ?? 'Дом 8';

    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/settings/rating');

    const main = page.locator('main');
    await expect(main).toContainText('Правила рейтинга');
    await expect(main).toContainText('Оценки уборки');
    await expect(main).toContainText('Пороги вниз');

    // Уровень дома: у сети кнопки копирования нет — копировать неоткуда.
    await page.getByTestId('rules-level').getByRole('link', { name: houseName }).click();
    await expect(page.getByTestId('copy-from')).toBeVisible();

    const violation = page.locator('input[name="value:violation"]');
    await violation.fill('-4');
    await page.getByRole('button', { name: 'Сохранить' }).click();

    await expect(page.getByTestId('rules-saved')).toBeVisible();
    await expect(page.locator('input[name="value:violation"]')).toHaveValue('-4');

    // Сеть осталась при своём: переопределение живёт на доме.
    await page.getByTestId('rules-level').getByRole('link', { name: 'Сеть' }).click();
    await expect(page.locator('input[name="value:violation"]')).toHaveValue('-1');
  });

  test('админ дома в редактор не попадает', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/rating');

    await expect(page).toHaveURL(/\/settings$/);
  });
});
