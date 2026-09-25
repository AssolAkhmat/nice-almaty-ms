import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';
import { expectNoHorizontalOverflow, measureOverflow } from './support/overflow';

/**
 * Ни одна страница не шире окна — на всех трёх ширинах (отзыв владельца,
 * 25 сентября 2026).
 *
 * Прежние приёмки проверяли, что элемент существует, а не что он помещается.
 * На телефоне текст выходил за рамки карточки, страница получала
 * горизонтальную прокрутку, и нижняя панель переставала доходить до края.
 * Жалоб было две, дефект один.
 *
 * Проверяются все статические страницы приложения, а не две названные:
 * дефект этого класса появляется там, где его не ждут.
 */
const ROUTES = [
  '/',
  '/absences',
  '/accounting',
  '/beds',
  '/contract',
  '/damages',
  '/deposit',
  '/documents',
  '/documents?status=approved',
  '/inventory',
  '/invoices',
  '/invoices/remote',
  '/notifications',
  '/profile',
  '/rating',
  '/residents',
  '/rotations',
  '/rotations/stats',
  '/settings',
  '/settings/accounts',
  '/settings/api-tokens',
  '/settings/audit',
  '/settings/contract-template',
  '/settings/document-types',
  '/settings/house',
  '/settings/houses',
  '/settings/network',
  '/settings/personal',
  '/settings/rating',
  '/settings/users',
  '/utilities',
] as const;

test.describe('ничто не вылезает за ширину окна', () => {
  test('страницы суперадмина помещаются в экран', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);

    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      await expectNoHorizontalOverflow(page, route);
    }
  });

  test('карточка жильца помещается в экран', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/residents');

    const first = page.getByTestId('resident-row').first();

    if ((await first.count()) === 0) {
      test.skip(true, 'в базе прогона нет жильцов');
    }

    await first.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/residents\/[0-9a-f-]+$/);

    await expectNoHorizontalOverflow(page, 'карточка жильца');
  });

  test('страницы админа дома помещаются в экран', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);

    for (const route of ['/', '/documents', '/beds', '/residents', '/utilities', '/rotations']) {
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      await expectNoHorizontalOverflow(page, `админ: ${route}`);
    }
  });

  test('вход помещается в экран', async ({ page }) => {
    await page.goto('/login');

    await expectNoHorizontalOverflow(page, '/login');
  });

  /*
   * Негативная фикстура: сама проверка обязана ловить переполнение. Без неё
   * она осталась бы зелёной, даже перестав что-либо измерять, — а это ровно
   * тот класс дефекта, из-за которого её и написали.
   */
  test('проверка ловит подложенный широкий элемент', async ({ page }) => {
    await page.goto('/login');

    await page.evaluate(() => {
      const wide = document.createElement('div');
      wide.style.width = '4000px';
      wide.style.height = '10px';
      wide.textContent = 'нарочно широкий';
      document.body.append(wide);
    });

    const report = await measureOverflow(page);

    expect(report.scrollWidth).toBeGreaterThan(report.clientWidth + 1);
    expect(report.offenders.length).toBeGreaterThan(0);
  });
});
