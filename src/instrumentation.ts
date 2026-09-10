import type { Instrumentation } from 'next';

/**
 * Падения страниц и маршрутов — в наш журнал (docs/01-ARCHITECTURE.md,
 * «Наблюдаемость»; docs/tasks/MAINTENANCE.md, T9.13).
 *
 * Сбой server action уже пишется через `actionErrorKey`; падение серверного
 * компонента до этого попадало только в журнал Next — без формы, к которой
 * привыкли, и без `digest`, который видит человек на странице ошибки.
 * Здесь оно уходит в тот же `pino`, что и остальное, с тем же `digest`.
 *
 * Логгер — Node-only, поэтому подключается лениво и только в Node-рантайме:
 * этот файл Next собирает и для edge.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { logger } = await import('@/lib/logger');
  const digest = (error as { digest?: string }).digest;

  logger.error(
    {
      err: error,
      digest,
      path: request.path,
      method: request.method,
      kind: context.routeType,
      route: context.routePath,
    },
    'необработанная ошибка страницы',
  );
};
