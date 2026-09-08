import { AppError } from './errors';
import { logger } from './logger';

/**
 * Ключ перевода для экрана после неудачного server action.
 *
 * Ошибка сервисного слоя (`AppError`) несёт ключ сама — это отказ по правилам,
 * и в журнал он не идёт. Всё остальное — сбой: экран о нём сказать не может,
 * а журнал обязан. До инцидента I12 сборка договора на боевой отвечала
 * `contract.errors.unknown`, и причина не попадала никуда: ни на экран,
 * ни в журнал. Здесь она уходит в журнал целиком, вместе со стеком.
 *
 * Модуль рассчитан на Node-рантайм: логгер `pino` в edge не поедет.
 */
export function actionErrorKey(error: unknown, unknownKey: string): string {
  if (error instanceof AppError) {
    return error.message;
  }

  logger.error({ err: error, key: unknownKey }, 'необработанная ошибка в server action');

  return unknownKey;
}
