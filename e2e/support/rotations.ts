import { expect, type Page } from '@playwright/test';

/**
 * Состав и норма дня — своими версиями с даты старта ряда (фаза 10 §2.2, §2.3).
 * Каждое сохранение перерисовывает раздел, поэтому норма правится на свежей
 * странице. Порядок мест и зон — их порядок в списке.
 */
export async function setRosterAndNorm(
  page: Page,
  rowName: string,
  beds: readonly string[],
  zones: readonly string[],
): Promise<void> {
  const card = page.locator('.rounded-card').filter({ hasText: rowName });
  await expect(card.locator('[data-testid^="day-form-"]')).toBeVisible();

  for (const [index, bed] of beds.entries()) {
    await card
      .locator('label')
      .filter({ hasText: bed })
      .locator('input[type="number"]')
      .fill(String(index));
  }
  await card.locator('[data-testid^="roster-save-"]').click();
  await expect(card.getByText('Состав сохранён')).toBeVisible();
  await page.reload();

  const fresh = page.locator('.rounded-card').filter({ hasText: rowName });

  for (const [index, zone] of zones.entries()) {
    await fresh
      .locator('[data-testid^="norm-row-"]')
      .filter({ hasText: zone })
      .locator('[data-testid^="norm-zone-"]')
      .fill(String(index));
  }
  await fresh.locator('[data-testid^="norm-save-"]').click();
  await expect(fresh.getByText('Норма сохранена')).toBeVisible();
  await page.reload();
}
