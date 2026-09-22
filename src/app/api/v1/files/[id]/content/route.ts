import { dispositionFor, type FileDisposition } from '@/domain/files';
import { apiRoute, requireApiActor } from '@/lib/api/route';
import { ForbiddenError } from '@/lib/errors';
import { getViewGrantKey, verifyViewGrant } from '@/lib/files/view-grant';
import { now } from '@/lib/time';
import { readFileContent } from '@/services/files';

/**
 * Отдача содержимого. Публичных ссылок не бывает (docs/01-ARCHITECTURE.md):
 * каждый доступ проходит проверку прав, поэтому ответ помечен как частный
 * и некэшируемый — иначе копия документа осела бы в промежуточном кэше.
 *
 * У человека в браузере проверок две: права, как и раньше, и пятиминутный
 * пропуск с `/view` (указание владельца, 22 сентября 2026). Вторая проверка
 * ничего не разрешает сверх первой — она только отнимает срок жизни у адреса,
 * оставшегося в истории вкладок. Боту с токеном API пропуск не нужен:
 * у него нет адресной строки, а область действия задана скоупами токена.
 */
function contentDisposition(originalName: string, disposition: FileDisposition): string {
  // Кириллица в имени: ASCII-запас для старых клиентов плюс RFC 5987 для всех остальных.
  const fallback = originalName.replaceAll(/[^ -~]/g, '_').replaceAll('"', '');

  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(originalName)}`;
}

export const GET = apiRoute<{ id: string }>(async (request, { requestId, params }) => {
  const actor = await requireApiActor(request, requestId);

  const query = new URL(request.url).searchParams;
  const disposition: FileDisposition = query.get('d') === 'inline' ? 'inline' : 'attachment';

  /*
   * `scopes` есть только у токена API: человек в браузере приходит без них,
   * и для него пропуск обязателен. Разделение именно такое, а не по наличию
   * cookie: cookie можно прислать и curl-ом.
   */
  if (actor.scopes === undefined) {
    const verdict = await verifyViewGrant(
      query.get('g') ?? '',
      { fileId: params.id, userId: actor.context.userId, disposition },
      now(),
      await getViewGrantKey(),
    );

    if (verdict === 'expired') {
      throw new ForbiddenError('Ссылка на документ истекла: откройте документ заново');
    }

    if (verdict !== 'ok') {
      throw new ForbiddenError('Документ открывается только по ссылке из системы');
    }
  }

  const content = await readFileContent(actor, params.id, { disposition });

  /*
   * Показывается только то, что браузер показывает безопасно; всё остальное
   * скачивается, даже когда просили показать. Проверка стоит после чтения:
   * тип берётся из записи файла, а не из адреса.
   */
  const actual = dispositionFor(content.mime, disposition);

  return new Response(content.stream, {
    status: 200,
    headers: {
      'content-type': content.mime,
      'content-length': String(content.sizeBytes),
      'content-disposition': contentDisposition(content.originalName, actual),
      'cache-control': 'private, no-store',
      /*
       * Тип не угадывается по содержимому: без этого заголовка браузер мог бы
       * счесть страницей файл, объявленный картинкой.
       */
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
    },
  });
});
