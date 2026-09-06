import type { Metadata, Viewport } from 'next';
import { Montserrat } from 'next/font/google';

import './globals.css';

const montserrat = Montserrat({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-montserrat',
});

export const metadata: Metadata = {
  title: 'Nice Almaty',
  description: 'Система администрирования сетью студенческих домов',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={montserrat.variable} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
