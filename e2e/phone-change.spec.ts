import { expect, test } from '@playwright/test';

import { login } from './support/login';
import { createResident, RESIDENT_PASSWORD, signInAs, uniquePhone } from './support/onboarding';
import { visibleTestId } from './support/visible';

/**
 * Смена номера телефона (T9.7). Номер — логин: свой меняется с паролем
 * в личных настройках, чужой — суперадмином в списке учётных записей.
 * До 9 сентября 2026 экрана не было, и номер правили в базе мимо журнала.
 */
test.describe('смена номера телефона', () => {
  test('свой номер меняется с паролем, и вход идёт по новому', async ({ page }) => {
    const phone = await createResident(page, 'Дом 1');
    const next = uniquePhone();

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto('/settings/personal');

    await page.getByTestId('new-own-phone').fill(next);
    await page.getByTestId('current-password').fill('не тот пароль');
    await page.getByTestId('phone-submit').click();
    await expect(page.getByTestId('phone-form').getByRole('alert')).toContainText(
      'Неверный текущий пароль',
    );

    await page.getByTestId('current-password').fill(RESIDENT_PASSWORD);
    await page.getByTestId('phone-submit').click();
    await expect(page.getByTestId('phone-changed')).toBeVisible();

    await signInAs(page, next, RESIDENT_PASSWORD);
    await page.goto('/settings/personal');
    await expect(page.getByTestId('new-own-phone')).toHaveValue(next);
  });

  test('суперадмин меняет чужой номер из списка учётных записей', async ({ page }) => {
    const phone = await createResident(page, 'Дом 1');
    const next = uniquePhone();

    await login(page);
    await page.goto('/settings/users');

    await visibleTestId(page, `change-phone-${phone}`).click();
    await page.getByTestId('change-phone-value').fill(next);
    await page.getByTestId('change-phone-submit').click();

    await expect(page.getByTestId('phone-changed')).toBeVisible();
    await expect(visibleTestId(page, `change-phone-${next}`)).toBeVisible();

    await signInAs(page, next, RESIDENT_PASSWORD);
  });
});
