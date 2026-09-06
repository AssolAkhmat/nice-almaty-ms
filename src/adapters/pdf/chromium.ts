import type { PdfHealth, PdfRenderer } from './types';

/**
 * Печать через chromium по протоколу CDP (`puppeteer-core`).
 *
 * Сам браузер в пакет не входит: в Docker берётся системный, на Vercel —
 * сборка `@sparticuz/chromium`. Драйвер знает только, как его запустить,
 * и обязан закрыть его при любом исходе: незакрытый chromium остаётся
 * висеть процессом и молча съедает память сервера.
 */

/** Поверхность страницы, которой пользуется драйвер. Больше от неё ничего не нужно. */
export interface PageLike {
  setContent: (html: string, options?: { waitUntil?: string }) => Promise<void>;
  pdf: (options?: Record<string, unknown>) => Promise<Uint8Array>;
}

export interface BrowserLike {
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
}

export interface ChromiumConfig {
  /** Путь к исполняемому файлу; по умолчанию его ищет сам puppeteer. */
  executablePath?: string | undefined;
  /** Подмена запуска: в тестах браузер не поднимается. */
  launch?: () => Promise<BrowserLike>;
}

/*
 * Флаги те же, что нужны chromium в контейнере: своей песочницы у него там нет,
 * а `/dev/shm` слишком мал — без этого он падает на первой же странице.
 */
const CONTAINER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

const PDF_OPTIONS = {
  format: 'A4',
  printBackground: true,
  margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '20mm' },
} as const;

async function launchSystemChromium(config: ChromiumConfig): Promise<BrowserLike> {
  // Динамический импорт: puppeteer-core тянет Node-only API и в edge не поедет.
  const puppeteer = await import('puppeteer-core');

  const browser = await puppeteer.launch({
    args: CONTAINER_ARGS,
    ...(config.executablePath === undefined ? {} : { executablePath: config.executablePath }),
  });

  return browser as unknown as BrowserLike;
}

export function createChromiumRenderer(config: ChromiumConfig = {}): PdfRenderer {
  const launch = config.launch ?? (() => launchSystemChromium(config));

  async function withBrowser<T>(body: (browser: BrowserLike) => Promise<T>): Promise<T> {
    const browser = await launch();

    try {
      return await body(browser);
    } finally {
      await browser.close();
    }
  }

  return {
    driver: 'chromium',

    async checkHealth(): Promise<PdfHealth> {
      try {
        await withBrowser(() => Promise.resolve());

        return { status: 'ok', driver: 'chromium' };
      } catch (error) {
        return {
          status: 'error',
          driver: 'chromium',
          reason: error instanceof Error ? error.message : 'chromium недоступен',
        };
      }
    },

    async render(html: string): Promise<Uint8Array> {
      return withBrowser(async (browser) => {
        const page = await browser.newPage();

        // Подпись приходит картинкой в data URL: печать до её загрузки
        // оставила бы на её месте пустое место.
        await page.setContent(html, { waitUntil: 'networkidle0' });

        return page.pdf(PDF_OPTIONS);
      });
    },
  };
}
