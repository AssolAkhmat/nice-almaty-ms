import { apiRoute } from '@/lib/api/route';
import { API_OPERATIONS } from '@/lib/api/openapi';

/**
 * Документация API (docs/06-API.md, `GET /api/docs`).
 *
 * Swagger UI подключается с CDN, но страница остаётся полезной и без него:
 * список маршрутов отрисован сразу, обычным HTML. В Docker-установке без
 * выхода в интернет — а такая возможна — пустой экран с крутящимся
 * колесом объяснял бы меньше, чем простая таблица (P7-11).
 */
const SWAGGER_VERSION = '5.17.14';

function rows(): string {
  return Object.entries(API_OPERATIONS)
    .flatMap(([path, operations]) =>
      operations.map(
        (operation) =>
          `<tr><td><code>${operation.method.toUpperCase()}</code></td><td><code>/api/v1${path}</code></td><td>${operation.summary}</td><td><code>${operation.scope ?? '—'}</code></td></tr>`,
      ),
    )
    .join('');
}

const PAGE = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta content="width=device-width, initial-scale=1" name="viewport" />
    <title>Nice Almaty API</title>
    <link href="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css" rel="stylesheet" />
    <style>
      body { margin: 0; font-family: Montserrat, system-ui, sans-serif; }
      main { max-width: 960px; margin: 0 auto; padding: 24px; }
      table { border-collapse: collapse; width: 100%; font-size: 14px; }
      th, td { border-bottom: 1px solid #d8dce3; padding: 8px; text-align: left; }
      code { font-family: ui-monospace, SFMono-Regular, monospace; }
    </style>
  </head>
  <body>
    <main>
      <h1>Nice Almaty API</h1>
      <p>
        Спецификация: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.
        Токен выдаёт суперадмин; заголовок <code>Authorization: Bearer</code>.
      </p>
      <table>
        <thead>
          <tr><th>Метод</th><th>Путь</th><th>Что делает</th><th>Скоуп</th></tr>
        </thead>
        <tbody>${rows()}</tbody>
      </table>
    </main>

    <div id="swagger"></div>
    <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js" crossorigin></script>
    <script>
      if (typeof SwaggerUIBundle === 'function') {
        SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#swagger' });
      }
    </script>
  </body>
</html>
`;

export const GET = apiRoute((_request, { requestId }) => {
  const response = new Response(PAGE, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-request-id': requestId,
      'cache-control': 'public, max-age=300',
    },
  });

  return Promise.resolve(response);
});
