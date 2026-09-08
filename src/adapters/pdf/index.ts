import { loadEnv } from '@/lib/env/load';

import { createChromiumRenderer, type BrowserLike } from './chromium';

import type ServerlessChromium from '@sparticuz/chromium';

export type { PdfDriver, PdfHealth, PdfRenderer } from './types';
export { createChromiumRenderer } from './chromium';

import type { PdfRenderer } from './types';

/**
 * Выбор способа запуска chromium по цели развёртывания
 * (docs/01-ARCHITECTURE.md, «Генерация PDF договора»).
 *
 * Docker — системный chromium из образа. Vercel — сборка
 * `@sparticuz/chromium`: в serverless обычного браузера нет. Пакет лежит
 * в зависимостях, а не ставится «на стороне Vercel»: боевая собирается
 * из репозитория, и пакета, которого нет в `package.json`, там не бывает
 * (инцидент I12, P9-2). В образ Docker он не попадает — standalone-вывод
 * исключает его трассировкой в `next.config.ts`.
 *
 * Импорт с литералом, а не с именем в переменной: трассировка сборки видит
 * только литерал, и без него пакет не попадал бы в бандл функции даже
 * установленным. Сам пакет объявлен внешним (`serverExternalPackages`):
 * он читает свой архив с диска относительно собственного файла.
 */
const SERVERLESS_PACKAGE = '@sparticuz/chromium';

async function launchServerlessChromium(): Promise<BrowserLike> {
  let chromium: typeof ServerlessChromium;

  try {
    chromium = (await import('@sparticuz/chromium')).default;
  } catch (cause) {
    throw new Error(
      `Для DEPLOY_TARGET=vercel нужен пакет ${SERVERLESS_PACKAGE}: в serverless системного chromium нет`,
      { cause },
    );
  }

  const puppeteer = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
  });

  return browser as unknown as BrowserLike;
}

export function getPdfRenderer(): PdfRenderer {
  const env = loadEnv();

  if (env.DEPLOY_TARGET === 'vercel') {
    return createChromiumRenderer({ launch: launchServerlessChromium });
  }

  return createChromiumRenderer({ executablePath: env.CHROMIUM_PATH });
}
