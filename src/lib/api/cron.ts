import { ForbiddenError, UnauthorizedError } from '../errors';

/**
 * Защита заданий планировщика (docs/01-ARCHITECTURE.md, «Планировщик»).
 *
 * Задание ходит по деньгам всей сети, а вызывают его раннер в Docker,
 * расписание Vercel и человек при разборе сбоя — сессии ни у кого из них
 * нет. Единственный ключ — заголовок `x-cron-secret`, и проверка живёт
 * отдельной чистой функцией: правило без негативной фикстуры считается
 * несуществующим (CLAUDE.md §2).
 */
export const CRON_SECRET_HEADER = 'x-cron-secret';

/**
 * Сравнение постоянного времени. Обычное `!==` выдаёт длину совпавшего
 * префикса задержкой ответа, а секрет расписания живёт в окружении долго
 * и подбирается без ограничения попыток.
 */
function matches(given: string, expected: string): boolean {
  let diff = given.length ^ expected.length;

  for (let index = 0; index < given.length; index += 1) {
    diff |= given.charCodeAt(index) ^ expected.charCodeAt(index % expected.length);
  }

  return diff === 0;
}

/**
 * Различие 401 и 403 то же, что у прав (P1-1): заголовка нет вовсе — 401,
 * заголовок есть, но чужой — 403.
 */
export function assertCronSecret(request: Request, expected: string): void {
  const given = request.headers.get(CRON_SECRET_HEADER);

  if (given === null || given === '') {
    throw new UnauthorizedError(`Задание вызывается с заголовком ${CRON_SECRET_HEADER}`);
  }

  if (!matches(given, expected)) {
    throw new ForbiddenError('Неверный секрет расписания');
  }
}
