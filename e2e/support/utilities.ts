import { expect, type Page } from '@playwright/test';

/**
 * Открыть коммунальный период месяца, заведя его, если его ещё нет.
 *
 * Показ месяца период больше не создаёт (22 сентября 2026, D24): раньше он
 * заводился сам при отрисовке, и приёмки этим пользовались, ничего не нажимая.
 * После правки три приёмки продолжали сразу заполнять строку периода —
 * и падали на поле, которого на экране нет.
 *
 * Помощник один на все приёмки: три копии одного шага и разошлись
 * в прошлый раз.
 */
export async function openUtilityPeriod(page: Page, month?: string): Promise<void> {
  await page.goto(month === undefined ? '/utilities' : `/utilities?month=${month}`);

  const start = page.getByTestId('start-period');

  if ((await start.count()) > 0) {
    await start.click();
  }

  /*
   * Форма строки — признак заведённого периода. Ждётся всегда, а не только
   * после нажатия: период мог завести другой прогон на той же машине,
   * и тогда кнопки нет, а форма появляется чуть позже отрисовки списка.
   */
  await expect(page.getByTestId('utility-title')).toBeVisible();
}
