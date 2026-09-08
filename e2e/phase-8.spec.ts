import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';
import { unique } from './support/onboarding';

/**
 * Приёмка фазы 8 (docs/tasks/PHASE-8.md).
 *
 * Экраны, которых не было: типы документов, план счетов и шаблон договора.
 * До фазы 8 эти сущности заводил только сид, и очистка боевой базы оставила
 * сеть без них — восстановить их через интерфейс было нечем.
 *
 * Код типа у каждой ширины свой: экран общий на всю сеть, и три копии приёмки
 * с одним кодом мешали бы друг другу — как дома в приёмках прошлых фаз.
 *
 * Проверки идут по кнопкам строки, а не по разметке таблицы: на узкой ширине
 * список рисуется карточками, и `<table>` там нет вовсе.
 */
test.describe('типы документов', () => {
  test('суперадмин заводит тип, правит срок и убирает в архив', async ({ page }, testInfo) => {
    // Код: латиница нижнего регистра и подчёркивание — он уходит в путь хранения файла.
    const code = `probe_${unique(testInfo.project.name.replace(/[^a-z0-9]/gi, '').toLowerCase()).replace(/-/g, '_')}`;

    await login(page);
    await page.goto('/settings/document-types');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.getByTestId('new-type-code').fill(code);
    await page.getByTestId('new-type-name-ru').fill('Проверочный тип');
    await page.locator('#new-name-kk').fill('Тексеру түрі');
    await page.locator('#new-name-en').fill('Probe type');
    await page.locator('#new-validity').fill('6');
    await page.getByTestId('create-type-submit').click();

    await expect(page.getByText(code).filter({ visible: true }).first()).toBeVisible();

    // Правка: срок меняется, код остаётся прежним.
    await page.getByTestId(`edit-${code}`).filter({ visible: true }).first().click();
    await expect(page.locator('#edit-validity')).toHaveValue('6');
    await page.locator('#edit-validity').fill('24');
    await page.getByTestId('edit-type-submit').click();

    await page.getByTestId(`edit-${code}`).filter({ visible: true }).first().click();
    await expect(page.locator('#edit-validity')).toHaveValue('24');
    await page.keyboard.press('Escape');

    // Архив: тип остаётся в списке помеченным, а не исчезает бесследно.
    await page.getByTestId(`archive-${code}`).filter({ visible: true }).first().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Архив|Мұрағат|Archive/i })
      .click();

    await expect(page.getByTestId(`edit-${code}`)).toHaveCount(0);
    await expect(page.getByText(code).filter({ visible: true }).first()).toBeVisible();
  });

  test('админ дома в типы документов не попадает', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/document-types');

    await expect(page).toHaveURL(/\/settings$/);
  });
});
