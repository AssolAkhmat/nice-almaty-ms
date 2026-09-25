import { type Locator, type Page } from '@playwright/test';

/**
 * Видимая копия строки таблицы.
 *
 * `src/components/ui/table.tsx` рисует каждую строку дважды: карточкой для
 * телефона и строкой таблицы для широкого экрана. Метки у копий одинаковые,
 * и `first()` на широком экране попадал в скрытую карточку — нажатие ждало
 * её появления до самого таймаута, а отчёт говорил «ждали: Click».
 *
 * Поэтому в приёмках берётся видимая копия, а не первая найденная.
 */
export function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true }).first();
}
