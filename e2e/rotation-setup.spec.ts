import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Чек-листы и группы допуска (T4.3) на трёх ширинах.
 *
 * Сценарии короткие и независимые. Длинная цепочка из нескольких сохранений
 * подряд здесь не живёт: удачное действие перерисовывает раздел целиком,
 * и следующее нажатие приходится в исчезающий узел. Что происходит внутри
 * одного сохранения, проверяют интеграционные тесты сервиса; экрану остаётся
 * доказать, что он работает на каждой ширине и переживает перезагрузку.
 *
 * Прогон убирает за собой зону; группы допуска интерфейс не удаляет —
 * их подчищает `global-setup` по префиксу имени, как учётные записи.
 */
function uniqueName(prefix: string): string {
  const suffix = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');

  return `${prefix} ${suffix}`;
}

/** Заводит зону дома и возвращает её название. */
async function createArea(page: Page): Promise<string> {
  const areaName = uniqueName('Зона e2e');

  await page.goto('/settings/house');
  await page.locator('#new-area-name').fill(areaName);
  // Порядок в конце списка: карточка ищется по названию, но так она ещё
  // и стоит последней — тест не зависит от прежнего содержимого дома.
  await page.locator('#new-area-order').fill('999');
  await page.getByTestId('add-area').click();
  await expect(page.locator('.rounded-card').filter({ hasText: areaName })).toBeVisible();

  return areaName;
}

async function archiveArea(page: Page, areaName: string): Promise<void> {
  await page.goto('/settings/house');
  await page
    .locator('.rounded-card')
    .filter({ hasText: areaName })
    .getByRole('button', { name: 'Убрать зону в архив' })
    .click();
  await expect(page.getByText(areaName)).toHaveCount(0);
}

test.describe('настройка ротаций', () => {
  // Настройка дома отрисовывает все зоны разом, и на трёх ширинах сразу
  // страница отвечает медленнее умолчания: это про скорость прогона,
  // а не про поведение системы.
  test.slow();

  test('админ заводит чек-лист зоны и убирает его', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);

    const areaName = await createArea(page);

    // Путь человека: ссылка из настроек дома.
    await page.getByTestId('to-rotation-setup').click();
    await expect(page.locator('main')).toContainText('Ротации: настройка');

    const areaCard = page.locator('.rounded-card').filter({ hasText: areaName });
    await areaCard.locator('input[name="title"]').first().fill('Уборка e2e');
    await areaCard.locator('input[name="peopleNeeded"]').first().fill('2');
    await areaCard.locator('textarea[name="items"]').first().fill('подмести\nвынести мусор');
    await areaCard.getByRole('button', { name: 'Сохранить', exact: true }).first().click();

    await expect(areaCard.getByText('Человек: 2', { exact: true })).toBeVisible();

    await page.reload();

    const saved = page.locator('.rounded-card').filter({ hasText: areaName });
    await expect(saved.locator('input[name="title"]').first()).toHaveValue('Уборка e2e');
    await expect(saved.locator('textarea[name="items"]').first()).toHaveValue(
      'подмести\nвынести мусор',
    );

    await saved.getByRole('button', { name: 'Убрать чек-лист' }).first().click();
    await expect(
      page.locator('.rounded-card').filter({ hasText: areaName }).getByText('Не заведён').first(),
    ).toBeVisible();

    await archiveArea(page, areaName);
  });

  test('админ заводит группу допуска, и она переживает перезагрузку', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/house/rotations');

    const groupName = uniqueName('e2e группа');
    await page.getByTestId('group-name-new').fill(groupName);
    await page.getByTestId('group-base-new').selectOption('male');
    await page.getByTestId('group-save-new').click();

    // Имя группы живёт в поле ввода, а не в тексте страницы: ждём подтверждение.
    await expect(page.getByTestId('group-form-new').getByText('Сохранено')).toBeVisible();

    await page.reload();

    // Группа пережила перезагрузку и открыта для правки своим полем.
    // Флажки допуска проверять здесь нельзя: они есть только у дома с зонами,
    // а зоны прогон убирает за собой.
    await expect(page.locator(`input[value="${groupName}"]`)).toBeVisible();
  });

  test('ряды ротаций собираются на экране настройки', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/house/rotations');

    // Форма нового ряда на месте со всем, из чего ряд состоит (§6.1).
    const form = page.getByTestId('row-form-new');
    await expect(form).toBeVisible();
    await expect(form.getByTestId('row-name-new')).toBeVisible();
    await expect(form.getByTestId('row-type-new')).toBeVisible();
    await expect(form.getByTestId('row-weekday-new')).toBeVisible();
    await expect(form.getByTestId('row-start-new')).toBeVisible();

    // Что ряд сохраняется и как он проверяется — интеграционные тесты
    // `rotation-rows.db-test`; сквозной путь через интерфейс идёт в приёмке фазы.
    await expect(page.locator('main')).toContainText('Ряды ротаций');
  });

  test('расписание генерируется до указанной даты', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/house/rotations');

    const generate = page.getByTestId('schedule-generate');
    await expect(generate).toBeVisible();
    await expect(page.getByTestId('schedule-until')).toBeVisible();

    await generate.click();

    // Рядов у дома может не быть вовсе — тогда честный ответ «новых занятий нет».
    await expect(page.getByTestId('schedule-done')).toBeVisible();
  });

  test('генеральная уборка распределяется на последнее воскресенье месяца', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/house/rotations');

    const date = page.getByTestId('general-date');
    await expect(date).toBeVisible();

    // Дата по умолчанию — воскресенье. День недели берётся у самой даты,
    // а не у момента: полночь по Алматы — это ещё вчерашний день в UTC.
    const value = await date.inputValue();
    expect(new Date(`${value}T00:00:00Z`).getUTCDay()).toBe(0);

    await page.getByTestId('general-plan').click();
    await expect(page.getByTestId('general-done')).toBeVisible();
  });

  test('суперадмин открывает настройку и выбирает дом', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/settings/house/rotations');

    const main = page.locator('main');
    await expect(main).toContainText('Ротации: настройка');
    // Домов в сети больше одного, поэтому переключатель домов на месте.
    await expect(main).toContainText('Дом 2');
  });
});
