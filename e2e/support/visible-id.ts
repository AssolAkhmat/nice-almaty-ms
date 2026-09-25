import { expect, type Page } from '@playwright/test';

/**
 * На экране не должно быть видимого идентификатора (указание владельца,
 * 25 сентября 2026).
 *
 * Три дефекта подряд оказались одной природы: в списке договоров стоял uuid
 * проживания, в списке пользователей — прочерк вместо дома, а жильцов нельзя
 * было отличить друг от друга. Везде интерфейс показывал идентификатор там,
 * где не нашлось имени. «Случилось трижды — случится и в четвёртый раз»,
 * поэтому правило стало проверкой.
 *
 * Смотрится именно видимый текст (`innerText`), а не разметка: идентификаторы
 * в `value`, `href` и `data-*` — рабочая механика форм и ссылок, человеку
 * они не показываются.
 */
export async function findVisibleIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const pattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

    return [...new Set(text.match(pattern) ?? [])];
  });
}

export async function expectNoVisibleId(page: Page, where: string): Promise<void> {
  const found = await findVisibleIds(page);

  expect(
    found,
    `${where}: на экране видно идентификатор вместо человека или названия: ${found.join(', ')}`,
  ).toEqual([]);
}
