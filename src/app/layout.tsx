import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { Montserrat } from 'next/font/google';

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
      </body>
    </html>
  );
}
