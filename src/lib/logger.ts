import pino from 'pino';

/**
 * Журнал в JSON (docs/01-ARCHITECTURE.md, «Наблюдаемость»).
 * В каждой записи должен быть request_id — для этого от корневого
 * логгера порождается дочерний на каждый запрос.
 *
 * Модуль рассчитан на Node-рантайм; в edge его импортировать нельзя.
 */
export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  base: undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;

/** Идентификатор запроса: попадает в журнал и в ответ об ошибке. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

export function requestLogger(requestId: string): Logger {
  return logger.child({ request_id: requestId });
}
