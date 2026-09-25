import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';
import { openUtilityPeriod as openPeriod } from './support/utilities';

/**
 * Экран коммунального периода (T3.7) на трёх ширинах.
 *
 * Числа распределения проверены в `src/domain/utilities.test.ts`, закрытие
 * периода — в `src/services/utilities.db-test.ts`. Здесь — что экран
 * открывается на прошлом месяце, форма строки читается, а предварительное
 * распределение показывает излишек, а не прячет его.
 *
 * Показ месяца период больше не создаёт (22 сентября 2026): раньше он
 * заводился сам при отрисовке, и приёмки этим пользовались, ничего не нажимая.
 */

test.describe('экран коммуналки', () => {
  test('админ видит период своего дома', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await openPeriod(page);

    const main = page.locator('main');
    await expect(main).toContainText('Коммунальные услуги');
    await expect(main).toContainText('Строки периода');
    await expect(main).toContainText('Предварительное распределение');
  });

  test('форма строки периода на месте', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await openPeriod(page);

    await expect(page.getByTestId('utility-title')).toBeVisible();
    await expect(page.getByTestId('utility-amount')).toBeVisible();
    await expect(page.getByTestId('close-period')).toBeVisible();
  });

  test('история по дому на месте (модуль 6, «Отчёты»)', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await openPeriod(page);

    const main = page.locator('main');
    await expect(main).toContainText('История по дому');

    /*
     * Закрытых периодов в базе прогона может не быть вовсе: колонки таблицы
     * тогда не рисуются, и вместо них стоит пустое состояние. Проверяется
     * то, что раздел объясняет себя в обоих случаях, а не одно из двух.
     */
    const hasRows = await main.getByText('Средняя доля').count();

    if (hasRows === 0) {
      await expect(main).toContainText('Закрытых периодов нет');
    }
  });

  test('излишек округления назван и объяснён', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await openPeriod(page);

    const main = page.locator('main');
    await expect(main).toContainText('Излишек округления');
    await expect(main).toContainText('Излишек остаётся в фонде дома');
  });

  /*
   * Тот самый отказ: список месяцев считался как «прошлый и два до него»,
   * поэтому текущего месяца в нём не было и завести его было нечем.
   * Первая ссылка переключателя — самый новый месяц, то есть текущий.
   */
  test('период за текущий месяц заводится с экрана', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/utilities');

    const months = page.getByTestId('month-link');
    await expect(months.first()).toBeVisible();

    await months.first().click();

    const start = page.getByTestId('start-period');

    if ((await start.count()) > 0) {
      await start.click();
    }

    await expect(page.getByTestId('utility-title')).toBeVisible();
    await expect(page.getByTestId('close-period')).toBeVisible();
  });

  /*
   * Месяц у каждой ширины свой: период дома один на месяц, и копия, успевшая
   * закрыть его первой, отбирала у остальных и форму строки, и кнопку
   * закрытия — та же природа, что у домов в приёмках фаз 3 и 4.
   */
  const CLOSING_MONTH: Readonly<Record<string, string>> = {
    'mobile-375': '2025-02',
    'tablet-768': '2025-03',
    'desktop-1440': '2025-04',
  };

  test('период без строк закрывается: дом мог не платить', async ({ page }, testInfo) => {
    const month = CLOSING_MONTH[testInfo.project.name];

    if (month === undefined) {
      throw new Error(`Месяц закрытия не задан для ширины ${testInfo.project.name}`);
    }

    await login(page, E2E_ACCOUNTS.adminHouse1);
    await openPeriod(page, month);

    await page.getByTestId('close-period').click();

    await expect(page.locator('main')).toContainText('Период закрыт');
  });
});
