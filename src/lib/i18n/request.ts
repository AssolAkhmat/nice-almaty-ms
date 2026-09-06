import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { ALMATY_TIME_ZONE } from '@/lib/time';

import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from './config';

/**
 * Язык — атрибут пользователя (P0-2), поэтому профиль главнее cookie.
 * Cookie остаётся для анонимных страниц: экран входа тоже переключается.
 */
async function resolveLocale(): Promise<Locale> {
  const { getCurrentSession } = await import('@/lib/session');
  const session = await getCurrentSession();

  if (session !== null && isLocale(session.user.locale)) {
    return session.user.locale;
  }

  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;

  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  const messages = (await import(`../../../messages/${locale}.json`)) as { default: unknown };

  return {
    locale,
    messages: messages.default as Record<string, unknown>,
    // Все даты и время показываются в зоне расчётов (docs/03-BUSINESS-RULES.md §0).
    timeZone: ALMATY_TIME_ZONE,
  };
});
