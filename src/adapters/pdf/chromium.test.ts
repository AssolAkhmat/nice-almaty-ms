import { describe, expect, it } from 'vitest';

import { createChromiumRenderer, type BrowserLike, type PageLike } from './chromium';

/**
 * Драйвер печати на chromium.
 *
 * Настоящий браузер в юнит-тестах не запускается: проверяется договор
 * с ним — что HTML попадает на страницу целиком, что PDF просят в A4
 * и что браузер закрывается даже тогда, когда печать упала. Незакрытый
 * chromium на сервере остаётся жить процессом и съедает память молча.
 */
interface Recorded {
  html: string | null;
  pdfOptions: unknown;
  closed: number;
  waitUntil: string | undefined;
}

function fakeBrowser(options: { failOnPdf?: boolean } = {}) {
  const recorded: Recorded = { html: null, pdfOptions: null, closed: 0, waitUntil: undefined };

  const page: PageLike = {
    setContent: (html, contentOptions) => {
      recorded.html = html;
      recorded.waitUntil = contentOptions?.waitUntil;

      return Promise.resolve();
    },
    pdf: (pdfOptions) => {
      recorded.pdfOptions = pdfOptions;

      return options.failOnPdf === true
        ? Promise.reject(new Error('печать сорвалась'))
        : Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    },
  };

  const browser: BrowserLike = {
    newPage: () => Promise.resolve(page),
    close: () => {
      recorded.closed += 1;

      return Promise.resolve();
    },
  };

  return { browser, recorded };
}

describe('печать документа', () => {
  it('отдаёт байты PDF', async () => {
    const { browser } = fakeBrowser();
    const renderer = createChromiumRenderer({ launch: () => Promise.resolve(browser) });

    const pdf = await renderer.render('<h1>Договор</h1>');

    expect([...pdf.slice(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('передаёт HTML целиком и ждёт загрузки ресурсов', async () => {
    const { browser, recorded } = fakeBrowser();
    const renderer = createChromiumRenderer({ launch: () => Promise.resolve(browser) });

    await renderer.render('<h1>Договор</h1><img src="data:image/png;base64,AAA" />');

    expect(recorded.html).toContain('<h1>Договор</h1>');
    // Подпись приходит картинкой: печать до её загрузки дала бы пустое место.
    expect(recorded.waitUntil).toBe('networkidle0');
  });

  it('печатает A4 с полями и фоном', async () => {
    const { browser, recorded } = fakeBrowser();
    const renderer = createChromiumRenderer({ launch: () => Promise.resolve(browser) });

    await renderer.render('<h1>Договор</h1>');

    expect(recorded.pdfOptions).toMatchObject({ format: 'A4', printBackground: true });
  });

  it('закрывает браузер после печати', async () => {
    const { browser, recorded } = fakeBrowser();
    const renderer = createChromiumRenderer({ launch: () => Promise.resolve(browser) });

    await renderer.render('<h1>Договор</h1>');

    expect(recorded.closed).toBe(1);
  });

  it('закрывает браузер и тогда, когда печать упала', async () => {
    const { browser, recorded } = fakeBrowser({ failOnPdf: true });
    const renderer = createChromiumRenderer({ launch: () => Promise.resolve(browser) });

    await expect(renderer.render('<h1>Договор</h1>')).rejects.toThrow('печать сорвалась');
    expect(recorded.closed).toBe(1);
  });
});

describe('проверка живости', () => {
  it('поднимает и гасит браузер', async () => {
    const { browser, recorded } = fakeBrowser();
    const renderer = createChromiumRenderer({ launch: () => Promise.resolve(browser) });

    expect(await renderer.checkHealth()).toEqual({ status: 'ok', driver: 'chromium' });
    expect(recorded.closed).toBe(1);
  });

  it('недоступный браузер объясняется словами, а не молчанием', async () => {
    const renderer = createChromiumRenderer({
      launch: () => Promise.reject(new Error('Could not find Chrome')),
    });

    const health = await renderer.checkHealth();

    expect(health.status).toBe('error');
    expect(health.status === 'error' ? health.reason : '').toContain('Could not find Chrome');
  });

  it('печать без браузера тоже отказывает внятно', async () => {
    const renderer = createChromiumRenderer({
      launch: () => Promise.reject(new Error('Could not find Chrome')),
    });

    await expect(renderer.render('<h1>Договор</h1>')).rejects.toThrow(/Chrome/);
  });
});
