import type { Locator, Page } from '@playwright/test';

/**
 * Таблица и мобильные карточки живут в разметке одновременно: какая из них
 * показана, решает CSS. Поэтому по идентификатору всегда находится две копии,
 * и нужна именно видимая.
 */
export function visibleTestId(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}
