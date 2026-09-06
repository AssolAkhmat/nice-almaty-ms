/**
 * Генерация PDF за адаптером (docs/01-ARCHITECTURE.md, «Генерация PDF договора»).
 *
 * Бизнес-код не знает, чем именно печатается документ: в Docker это системный
 * chromium, на Vercel — сборка `@sparticuz/chromium`. Интерфейс один,
 * и договор собирается одинаково в обоих окружениях.
 */
export type PdfDriver = 'chromium';

export type PdfHealth =
  { status: 'ok'; driver: PdfDriver } | { status: 'error'; driver: PdfDriver; reason: string };

export interface PdfRenderer {
  readonly driver: PdfDriver;
  /** Проверка живости: браузер запускается и закрывается, документ не печатается. */
  checkHealth: () => Promise<PdfHealth>;
  /** HTML целиком (со стилями внутри) в PDF формата A4. */
  render: (html: string) => Promise<Uint8Array>;
}
