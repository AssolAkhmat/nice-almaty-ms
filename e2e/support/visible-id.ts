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
 * Смотрится именно видимый текст, а не разметка: идентификаторы в `value`,
 * `href` и `data-*` — рабочая механика форм и ссылок, человеку они
 * не показываются.
 *
 * Отказ называет место: тег, ближайший `data-testid` и кусок текста вокруг.
 * Без этого отчёт перечислял тридцать идентификаторов и ни слова о том, какая
 * строка их печатает, — искать приходилось перебором по всему экрану
 * (правило увиденного отказа, CLAUDE.md §2).
 */
export interface VisibleId {
  /** Ближайший `data-testid` — свой или родительский; пусто, если его нет. */
  testId: string;
  tag: string;
  /** Текст вокруг найденного идентификатора. */
  text: string;
  value: string;
}

export async function findVisibleIdPlaces(page: Page): Promise<VisibleId[]> {
  return page.evaluate(() => {
    const pattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const found: {
      testId: string;
      tag: string;
      text: string;
      value: string;
    }[] = [];
    const seen = new Set<string>();

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      const match = pattern.exec(text);

      if (match === null) {
        continue;
      }

      const parent = node.parentElement;

      if (parent === null) {
        continue;
      }

      /*
       * Сырая запись журнала — объявленное исключение: снимки «до» и «после»
       * показывают значения теми, какими они легли в базу, и идентификатор
       * там — сами данные, а не подпись вместо человека.
       */
      if (parent.closest('[data-raw-record]') !== null) {
        continue;
      }

      /* Невидимое на экране показанным не считается. */
      const style = getComputedStyle(parent);

      if (style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }

      const value = match[0];

      if (seen.has(value)) {
        continue;
      }

      seen.add(value);

      const holder = parent.closest('[data-testid]');
      const start = Math.max(0, match.index - 25);

      found.push({
        testId: holder?.getAttribute('data-testid') ?? '',
        tag: parent.tagName.toLowerCase(),
        text: text.slice(start, match.index + value.length + 25).trim(),
        value,
      });
    }

    return found;
  });
}

/** Только значения: нужно негативной фикстуре на саму проверку. */
export async function findVisibleIds(page: Page): Promise<string[]> {
  return (await findVisibleIdPlaces(page)).map((place) => place.value);
}

export async function expectNoVisibleId(page: Page, where: string): Promise<void> {
  const found = await findVisibleIdPlaces(page);

  const details = found
    .map(
      (place) => `${place.tag}${place.testId === '' ? '' : `[${place.testId}]`} → «${place.text}»`,
    )
    .join('\n');

  expect(
    found.map((place) => place.value),
    `${where}: на экране видно идентификатор вместо человека или названия.\n${details}`,
  ).toEqual([]);
}
