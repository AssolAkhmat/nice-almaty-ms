import { createTranslator } from 'next-intl';

import { ALMATY_TIME_ZONE } from '@/lib/time';

import { type Locale } from './config';

/**
 * Словарь на сервере: там, где текст нужен не читающему, а документу.
 *
 * Уведомление собирается сразу на трёх языках, договор — на языке сети.
 * В обоих случаях строки живут в словарях, а не в коде (CLAUDE.md §4),
 * и загрузчик у них один: два кеша словарей рано или поздно разошлись бы.
 */
export type Messages = Record<string, unknown>;

export type PlainValues = Record<string, string | number>;

const cache = new Map<Locale, Messages>();

export async function messagesFor(locale: Locale): Promise<Messages> {
  const known = cache.get(locale);

  if (known !== undefined) {
    return known;
  }

  const loaded = (await import(`../../../messages/${locale}.json`)) as { default: Messages };
  cache.set(locale, loaded.default);

  return loaded.default;
}

/**
 * Один ключ на заданном языке.
 *
 * Ключ вычисляется, а типы next-intl знают только те, что есть в словаре
 * на момент сборки; полноту словаря стережёт тест сообщений, поэтому
 * переводчик берётся как обычная функция от строки — так же, как в текстах
 * уведомлений и подписях журнала (P2-45).
 */
export async function textIn(
  locale: Locale,
  key: string,
  values: PlainValues = {},
): Promise<string> {
  const translate = createTranslator({
    locale,
    messages: await messagesFor(locale),
    timeZone: ALMATY_TIME_ZONE,
  }) as unknown as (key: string, values?: PlainValues) => string;

  return translate(key, values);
}
