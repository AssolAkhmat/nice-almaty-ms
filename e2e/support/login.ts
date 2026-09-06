import { expect, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from '../global-setup';

/** Вход через настоящую форму: обходных путей в приложении нет и быть не должно. */
export async function login(page: Page, phone: string = E2E_ACCOUNTS.superadmin): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('phone').fill(phone);
  await page.getByTestId('password').fill(E2E_PASSWORD);
  await page.getByTestId('submit').click();

  await expect(page.getByTestId('sidebar')).toBeAttached();
}
