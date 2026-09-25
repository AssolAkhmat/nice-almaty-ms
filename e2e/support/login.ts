import { expect, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from '../global-setup';

import { clearLoginLimits } from './login-limits';

/** Вход через настоящую форму: обходных путей в приложении нет и быть не должно. */
export async function login(page: Page, phone: string = E2E_ACCOUNTS.superadmin): Promise<void> {
  /*
   * Счётчики попыток входа сбрасываются перед каждым входом: приёмка входит
   * сотнями раз с одного адреса, а вход ограничен десятью попытками
   * за пятнадцать минут (P1-2). Ограничение боевое и остаётся как есть —
   * чистятся счётчики приёмки, как чистятся её жильцы и дома.
   */
  await clearLoginLimits();

  await page.goto('/login');
  await page.getByTestId('phone').fill(phone);
  await page.getByTestId('password').fill(E2E_PASSWORD);
  await page.getByTestId('submit').click();

  /*
   * Сообщение формы проверяется раньше боковой панели: «панель не найдена»
   * не говорит, почему вход не прошёл, а текст ошибки говорит. Ровно из-за
   * этой немоты 322 упавшие проверки трое суток выглядели одинаково
   * (25 сентября 2026).
   */
  const failure = page.getByTestId('login-error');

  if ((await failure.count()) > 0) {
    expect(await failure.textContent(), `вход не прошёл: ${phone}`).toBe('');
  }

  await expect(page.getByTestId('sidebar'), `вход не прошёл: ${phone}`).toBeAttached();
}
