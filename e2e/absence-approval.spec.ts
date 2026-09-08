import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import {
  assignBed,
  createResident,
  createRoomWithBed,
  fillProfile,
  payDeposit,
  RESIDENT_PASSWORD,
  signInAs,
  unique,
} from './support/onboarding';

/**
 * Долгосрочное отсутствие требует одобрения админа (§5, §9): после подачи
 * оно ждёт решения, и только одобрение делает его одобренным (T9.12).
 *
 * Отсутствия открыты жильцу после депозита (§1.2), поэтому сценарий проходит
 * заселение целиком через интерфейс: аккаунт, профиль, место, депозит.
 */
test.describe('одобрение долгосрочного отсутствия', () => {
  test('поданное жильцом ждёт решения, одобряет админ', async ({ page }) => {
    const phone = await createResident(page, 'Дом 1');
    const lastName = unique('Отъезд');
    const fullName = `${lastName} Тест`;

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await fillProfile(page, lastName);

    await signInAs(page, E2E_ACCOUNTS.adminHouse1, E2E_PASSWORD);
    const { room, bed } = await createRoomWithBed(page);
    await assignBed(page, fullName, room, bed);
    await payDeposit(page, fullName);

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto('/absences');
    await expect(page).toHaveURL(/\/absences$/);

    await page.getByTestId('absence-type').selectOption('long');
    await page.getByTestId('absence-reason').fill('Отъезд к родителям');
    await page.getByTestId('absence-submit').click();

    const mine = page.getByTestId('absences-mine');
    await expect(mine).toContainText('Ждёт решения');
    await expect(mine).not.toContainText('Одобрено');

    await signInAs(page, E2E_ACCOUNTS.adminHouse1, E2E_PASSWORD);
    await page.goto('/absences');

    // Очередь — общий список дома: три копии приёмки подают по заявке, нужна своя строка.
    const queued = page.getByTestId('absence-queue').locator('li').filter({ hasText: fullName });
    await expect(queued).toBeVisible();
    await queued.getByRole('button', { name: 'Одобрить' }).click();

    await expect(queued).toHaveCount(0);

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto('/absences');
    await expect(page.getByTestId('absences-mine')).toContainText('Одобрено');
  });
});
