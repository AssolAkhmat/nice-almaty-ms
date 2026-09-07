import { getTranslations } from 'next-intl/server';

import { DEFAULT_LOCALE } from '@/lib/i18n/config';

import type { MetadataRoute } from 'next';

/**
 * Манифест установки на телефон (docs/07-ROADMAP.md, фаза 6).
 *
 * Манифест у приложения один, а язык — атрибут пользователя (P0-2):
 * система читает его до входа, когда о человеке ещё ничего не известно.
 * Поэтому подписи берутся в языке сети по умолчанию, а не в языке
 * запроса — иначе значок на домашнем экране менял бы имя от того,
 * кто последним открыл страницу.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getTranslations({ locale: DEFAULT_LOCALE, namespace: 'app' });

  return {
    name: t('name'),
    short_name: t('name'),
    description: t('description'),
    lang: DEFAULT_LOCALE,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#004aad',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
