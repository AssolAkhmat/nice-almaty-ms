import { loadEnv } from '@/lib/env/load';

import { createChromiumRenderer, type BrowserLike } from './chromium';

export type { PdfDriver, PdfHealth, PdfRenderer } from './types';
export { createChromiumRenderer } from './chromium';

import type { PdfRenderer } from './types';

/**
 * Выбор способа запуска chromium по цели развёртывания
 * (docs/01-ARCHITECTURE.md, «Генерация PDF договора»).
 *
 * Docker — системный chromium из образа. Vercel — сборка
 * `@sparticuz/chromium`: в serverless обычного браузера нет. Пакет весит
 * десятки мегабайт и нужен только этой цели, поэтому он не в зависимостях,
 * а подключается на стороне Vercel (P2-16, docs/DEPLOY-VERCEL.md).
 */
const SERVERLESS_PACKAGE = '@sparticuz/chromium';

interface ServerlessChromium {
  args: string[];
  executablePath: () => Promise<string>;
}

async function launchServerlessChromium(): Promise<BrowserLike> {
  let chromium: ServerlessChromium;

  try {
    // Имя в переменной: пакета нет в сборке для Docker, и тянуть его туда незачем.
    chromium = (
      (await import(/* turbopackIgnore: true */ SERVERLESS_PACKAGE)) as {
        default: ServerlessChromium;
      }
    ).default;
  } catch {
    throw new Error(
      `Для DEPLOY_TARGET=vercel нужен пакет ${SERVERLESS_PACKAGE}: в serverless системного chromium нет`,
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
