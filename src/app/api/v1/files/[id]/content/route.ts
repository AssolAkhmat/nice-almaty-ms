import { apiRoute, requireApiActor } from '@/lib/api/route';
import { readFileContent } from '@/services/files';

/**
 * Отдача содержимого. Публичных ссылок не бывает (docs/01-ARCHITECTURE.md):
 * каждый доступ проходит проверку прав, поэтому ответ помечен как частный
 * и некэшируемый — иначе копия документа осела бы в промежуточном кэше.
 */
function contentDisposition(originalName: string): string {
  // Кириллица в имени: ASCII-запас для старых клиентов плюс RFC 5987 для всех остальных.
  const fallback = originalName.replaceAll(/[^ -~]/g, '_').replaceAll('"', '');

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(originalName)}`;
}

export const GET = apiRoute<{ id: string }>(async (request, { requestId, params }) => {
  const actor = await requireApiActor(request, requestId);
  const content = await readFileContent(actor, params.id);

  return new Response(content.stream, {
    status: 200,
    headers: {
      'content-type': content.mime,
      'content-length': String(content.sizeBytes),
      'content-disposition': contentDisposition(content.originalName),
      'cache-control': 'private, no-store',
      'x-request-id': requestId,
    },
  });
});
