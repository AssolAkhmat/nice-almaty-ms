/**
 * Локали приложения (docs/04-MODULES/11-users-settings.md).
 * Префикса локали в URL нет: язык — атрибут пользователя, а не адреса
 * (docs/08-DECISIONS.md, P0-2). Источник — cookie, с фазы 1 — профиль.
 */
export const LOCALES = ['ru', 'kk', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ru';

/** Имя cookie совпадает с соглашением next-intl. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/** Год: cookie переживает сессию, пока пользователь сам не сменит язык. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.includes(value as Locale);
}
