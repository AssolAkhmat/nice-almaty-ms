import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Настройка дома (T2.15) на трёх ширинах.
 *
 * Проверяется полный оборот: зона — место — архив, — потому что база между
 * прогонами общая, и созданное должно уходить из неё тем же путём, каким
 * его убирает человек.
 */
function uniqueName(prefix: string): string {
  const suffix = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');

  return `${prefix} ${suffix}`;
}

test.describe('настройка дома', () => {
  test('админ заводит комнату и место, а потом убирает их в архив', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/house');

    const roomName = uniqueName('Комната e2e');
    const bedLabel = uniqueName('Место e2e');

    await page.locator('#new-area-name').fill(roomName);
    // Порядок в конце списка: карточка комнаты ищется по названию, но так
    // она ещё и стоит последней — тест не зависит от прежнего содержимого дома.
    await page.locator('#new-area-order').fill('999');
    await page.getByTestId('add-area').click();

    const room = page.locator('.rounded-card').filter({ hasText: roomName });
    await expect(room).toBeVisible();

    await room.locator('input[name="label"]').fill(bedLabel);
    await room.locator('input[name="defaultPrice"]').fill('70000');
    await room.getByTestId('add-bed').click();

    const bed = page.locator('li').filter({ hasText: bedLabel });
    await expect(bed).toBeVisible();
    await expect(bed).toContainText('Свободно');

    await bed.getByRole('button', { name: 'Убрать место в архив' }).click();
    await expect(page.getByText(bedLabel)).toHaveCount(0);

    const emptyRoom = page.locator('.rounded-card').filter({ hasText: roomName });
    await emptyRoom.getByRole('button', { name: 'Убрать зону в архив' }).click();
    await expect(page.getByText(roomName)).toHaveCount(0);
  });

  test('админ второго дома настраивает свой дом, а не соседний', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse2);
    await page.goto('/settings/house');

    const main = page.locator('main');
    await expect(main).toContainText('Настройки дома');
    await expect(main).toContainText('Депозит дома');
    // Выбор дома — только у суперадмина: у админа дом один и он свой.
    await expect(main).not.toContainText('Дом 1');
  });
});
