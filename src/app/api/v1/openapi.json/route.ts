import { loadEnv } from '@/lib/env/load';
import { apiRoute } from '@/lib/api/route';
import { buildOpenApiDocument } from '@/lib/api/openapi';

/**
 * Спецификация API (docs/06-API.md).
 *
 * Отдаётся без проверки прав: она описывает форму запросов, а не данные,
 * и нужна именно тому, у кого токена ещё нет — чтобы понять, о чём просить.
 * Ничего из содержимого сети в ней нет.
 */
export const GET = apiRoute((_request, { requestId }) => {
  const document = buildOpenApiDocument({ serverUrl: new URL('/api/v1', loadEnv().APP_URL).href });

  return Promise.resolve(
    Response.json(document, {
      status: 200,
      headers: { 'x-request-id': requestId, 'cache-control': 'public, max-age=300' },
    }),
  );
});
