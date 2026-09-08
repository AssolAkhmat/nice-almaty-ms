'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { getCurrentSession } from '@/lib/session';
import { savePersonalSettings } from '@/services/settings';

import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from './config';

/**
 * Смена языка интерфейса переключателем в шапке.
 *
 * Язык — атрибут пользователя (P0-2): у вошедшего он читается из учётной
 * записи, и cookie её не перебивает. До инцидента I14 действие писало только
 * cookie, поэтому у вошедшего язык не менялся вовсе — интерфейс оставался
 * русским при любом выборе, а экран входа переключался исправно. Теперь
 * у вошедшего обновляется учётная запись (тем же сервисом, что и личные
 * настройки), cookie остаётся запасным путём для анонимных страниц.
 */
export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) {
    throw new Error(`Неизвестная локаль: ${String(locale)}`);
  }

  const session = await getCurrentSession();
  if (session !== null) {
    await savePersonalSettings({ context: session.context }, { locale, theme: session.user.theme });
    revalidatePath('/', 'layout');
  }

  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    maxAge: LOCALE_COOKIE_MAX_AGE,
    path: '/',
    sameSite: 'lax',
  });
}
