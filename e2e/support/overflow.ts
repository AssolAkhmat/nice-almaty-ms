import { expect, type Page } from '@playwright/test';

/**
 * Содержимое не шире окна (отзыв владельца, 25 сентября 2026).
 *
 * Приёмки гонялись на 375/768/1440 и ловили только то, что элемент
 * существует, а не то, что он помещается. На телефоне при этом текст
 * выходил за рамки карточки, страница получала горизонтальную прокрутку,
 * и нижняя панель переставала доходить до края экрана — обе жалобы
 * оказались одним дефектом.
 *
 * Проверка называет виновника: голое «1200 больше 412» не говорит, что
 * чинить, а список вылезших элементов говорит.
 */
export interface OverflowReport {
  scrollWidth: number;
  clientWidth: number;
  offenders: { tag: string; className: string; text: string; right: number }[];
}

export async function measureOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth;
    const offenders: OverflowReport['offenders'] = [];

    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      const rect = element.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) {
        continue;
      }

      /* Элемент со своей прокруткой — не переполнение страницы, а так и задумано. */
      const style = getComputedStyle(element);
      if (
        style.overflowX === 'auto' ||
        style.overflowX === 'scroll' ||
        style.overflowX === 'hidden'
      ) {
        continue;
      }

      if (rect.right > limit + 1) {
        offenders.push({
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
          text: (element.textContent ?? '').trim().slice(0, 60),
          right: Math.round(rect.right),
        });
      }
    }

    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: limit,
      /* Ближайшие к корню интересны больше: дети вылезли из-за них. */
      offenders: offenders.slice(0, 5),
    };
  });
}

export async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const report = await measureOverflow(page);

  const details = report.offenders
    .map((item) => `${item.tag}.${item.className} → ${String(item.right)}px «${item.text}»`)
    .join('\n');

  expect(
    report.scrollWidth,
    `${where}: содержимое шире окна (${String(report.scrollWidth)} при ${String(report.clientWidth)}).\n${details}`,
  ).toBeLessThanOrEqual(report.clientWidth + 1);
}
