import { apiRoute, requireApiActor } from '@/lib/api/route';
import { grantFileView } from '@/services/files';

import type { FileDisposition } from '@/lib/files/view-grant';

/**
 * Открытие документа (указание владельца, 22 сентября 2026).
 *
 * Раньше документ можно было только скачать, и медицинские справки жильцов
 * оседали в «Загрузках» на личных устройствах админов. Этот адрес проверяет
 * права, выдаёт пятиминутный пропуск и переводит браузер на содержимое —
 * встроенным просмотрщиком, без сторонних библиотек и без отправки файла
 * куда-либо наружу.
 *
 * Постоянный здесь только этот адрес; тот, что останется в адресной строке
 * и в истории браузера, перестанет работать через пять минут.
 */
export const GET = apiRoute<{ id: string }>(async (request, { requestId, params }) => {
  const actor = await requireApiActor(request, requestId);

  const disposition: FileDisposition =
    new URL(request.url).searchParams.get('download') === '1' ? 'attachment' : 'inline';

  const grant = await grantFileView(actor, params.id, disposition);

  const target = `/api/v1/files/${params.id}/content?d=${disposition}&g=${encodeURIComponent(grant)}`;

  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      // Перенаправление с пропуском внутри не должно осесть ни в одном кэше.
      'cache-control': 'private, no-store',
      'x-request-id': requestId,
    },
  });
});
