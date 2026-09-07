import { createTranslator } from 'next-intl';

import { ALMATY_TIME_ZONE } from '@/lib/time';

import { LOCALES, type Locale } from './config';

/**
 * Тексты уведомления во всех локалях (docs/02-DATA-MODEL.md, `notifications`).
 *
 * Уведомление хранит заголовок и текст сразу на трёх языках: язык выбирает
 * читающий, а не отправитель, и задание планировщика вообще не знает, кто
 * и на каком языке это откроет. Захардкоженных строк здесь нет — только
 * ключи словаря, как и в интерфейсе (CLAUDE.md §4).
 */
type Messages = Record<string, unknown>;

const cache = new Map<Locale, Messages>();

async function messagesFor(locale: Locale): Promise<Messages> {
  const known = cache.get(locale);

  if (known !== undefined) {
    return known;
  }

  const loaded = (await import(`../../../messages/${locale}.json`)) as { default: Messages };
  cache.set(locale, loaded.default);

  return loaded.default;
}

/**
 * Значение подстановки. Обычно это строка или число, но название,
 * которое само хранится на трёх языках — тип документа, дом, зона, —
 * подставляется своим переводом в каждую локаль.
 */
export type TextValue = string | number | Partial<Record<Locale, string>>;

export type TextValues = Record<string, TextValue>;

type PlainValues = Record<string, string | number>;

type Translate = (key: string, values?: PlainValues) => string;

function valuesIn(values: TextValues, locale: Locale): PlainValues {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      typeof value === 'object' ? (value[locale] ?? '') : value,
    ]),
  );
}

export interface NotificationTexts {
  title: Record<Locale, string>;
  body: Record<Locale, string>;
}

/**
 * Заголовок и текст события по коду из `notifications.messages`.
 *
 * Значения подставляются одни и те же во все локали: числа и даты
 * приходят уже готовыми строками, потому что формат даты в системе один
 * (`YYYY-MM-DD`, docs/03-BUSINESS-RULES.md §0).
 */
export async function notificationTexts(
  code: string,
  values: TextValues = {},
): Promise<NotificationTexts> {
  const title: Partial<Record<Locale, string>> = {};
  const body: Partial<Record<Locale, string>> = {};

  for (const locale of LOCALES) {
    /*
     * Ключ здесь вычисляется, а типы next-intl знают только те, что есть
     * в словаре на момент сборки. Полноту словаря стережёт тест сообщений,
     * поэтому переводчик берётся как обычная функция от строки — так же,
     * как это сделано для подписей журнала аудита (P2-45).
     */
    const translate = createTranslator({
      locale,
      messages: await messagesFor(locale),
      timeZone: ALMATY_TIME_ZONE,
      namespace: 'notifications.messages',
    }) as unknown as Translate;

    const plain = valuesIn(values, locale);

    title[locale] = translate(`${code}.title`, plain);
    body[locale] = translate(`${code}.body`, plain);
  }

  return {
    title: title as Record<Locale, string>,
    body: body as Record<Locale, string>,
  };
}
