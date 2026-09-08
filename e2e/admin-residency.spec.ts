import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import { login } from './support/login';
import { visibleTestId } from './support/visible';
import {
  assignBed,
  createRoomWithBed,
  fillProfile,
  signInAs,
  unique,
  uniquePhone,
} from './support/onboarding';

/**
 * Админ — жилец своего дома (D11, §6 «включая админа», P9-3).
 *
 * До 9 сентября 2026 учётная запись админа проживания не заводила, и место
 * ему было не назначить: в списке незаселённых его не было. Здесь проверяются
 * оба пути: новому админу проживание достаётся вместе с учётной записью,
 * заведённому до правила — кнопкой суперадмина.
 */
const ADMIN_PASSWORD = 'parol-admina-priemka';

/** Суперадмин заводит админа, тот меняет временный пароль — как жилец в §1.2. */
async function createAdmin(page: Page, houseName: string): Promise<string> {
  const phone = uniquePhone();

  await login(page, E2E_ACCOUNTS.superadmin);
  await page.goto('/settings/users');
  await page.getByTestId('new-phone').fill(phone);
  await page.getByTestId('new-role').selectOption('admin');
  await page.getByTestId('new-house').selectOption({ label: houseName });
  await page.getByTestId('create-submit').click();

  await expect(page.getByTestId('temporary-password')).toBeVisible();
  const temporary = (await page.getByTestId('temporary-password-value').innerText()).trim();

  await signInAs(page, phone, temporary, { temporary: true });
  await page.getByTestId('new-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('confirmation').fill(ADMIN_PASSWORD);
  await page.getByTestId('submit').click();
  await expect(page).toHaveURL(/\/login/);

  return phone;
}

test.describe('админ — жилец своего дома', () => {
  test('новому админу назначается место', async ({ page }) => {
    const phone = await createAdmin(page, 'Дом 1');
    const lastName = unique('Админский');

    // Имя нужно схеме мест: без профиля в списке стоял бы идентификатор.
    await signInAs(page, phone, ADMIN_PASSWORD);
    await fillProfile(page, lastName);

    await signInAs(page, E2E_ACCOUNTS.adminHouse1, E2E_PASSWORD);
    const { room, bed } = await createRoomWithBed(page);
    await assignBed(page, `${lastName} Тест`, room, bed);

    await page.goto('/beds');
    await expect(page.getByText(`${lastName} Тест`)).toBeVisible();
  });

  /*
   * Сидовый админ заведён без проживания — ровно как учётные записи до правила.
   * Одна ширина: админ один, и три копии отбирали бы кнопку друг у друга;
   * заведённое проживание убирает следующий прогон (`global-setup.ts`).
   */
  test('админу, заведённому до правила, суперадмин заводит проживание', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-1440', 'сидовый админ один на все ширины');

    await login(page, E2E_ACCOUNTS.superadmin);
    await page.goto('/settings/users');

    // Таблица рисует строку дважды — карточкой и строкой, — видима одна.
    const button = visibleTestId(page, `open-residency-${E2E_ACCOUNTS.adminHouse2}`);
    const next = page
      .getByRole('navigation', { name: 'Постраничная навигация' })
      .getByRole('button', { name: 'Вперёд' });

    // Список идёт от новых к старым: сидовый админ — на последних страницах,
    // а пока учётных записей меньше страницы, постраничной навигации нет вовсе.
    while (!(await button.isVisible()) && (await next.count()) > 0 && (await next.isEnabled())) {
      await next.click();
    }

    await expect(button).toBeVisible();
    await button.click();

    await expect(page.getByTestId('residency-opened')).toBeVisible();
    await expect(button).toHaveCount(0);
  });
});
