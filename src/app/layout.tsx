import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { Montserrat } from 'next/font/google';

import { RegisterServiceWorker } from '@/components/pwa/register-service-worker';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { getCurrentSession } from '@/lib/session';
import { ThemeScript } from '@/components/theme/theme-script';

import type { Metadata, Viewport } from 'next';

import './globals.css';

const montserrat = Montserrat({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-montserrat',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');

  return {
    title: t('name'),
    description: t('description'),
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /*
   * Цвет строки состояния в установленном приложении. Значений два:
   * в тёмной теме синий `#004AAD` на тёмном фоне даёт полтора к одному
   * и выглядит грязным пятном (docs/05-DESIGN-SYSTEM.md).
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#004aad' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0f17' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, session] = await Promise.all([getLocale(), getCurrentSession()]);

  return (
    <html className={montserrat.variable} lang={locale} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <NextIntlClientProvider>
          <ThemeProvider {...(session === null ? {} : { profileTheme: session.user.theme })}>
            {children}
          </ThemeProvider>
        </NextIntlClientProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
