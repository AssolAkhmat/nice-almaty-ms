'use server';

import { cookies } from 'next/headers';

import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from './config';

/**
 * Смена языка интерфейса. В фазе 0 хранится только в cookie;
 * с фазы 1 значение дублируется в профиль пользователя (users.locale).
 */
export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) {
    throw new Error(`Неизвестная локаль: ${String(locale)}`);
  }

  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    maxAge: LOCALE_COOKIE_MAX_AGE,
    path: '/',
    sameSite: 'lax',
  });
}
