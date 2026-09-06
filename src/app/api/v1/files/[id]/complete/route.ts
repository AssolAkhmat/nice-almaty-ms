import { apiJson, apiRoute, requireApiActor } from '@/lib/api/route';
import { fileResource } from '@/lib/api/file-resource';
import { completeUpload } from '@/services/files';

/**
 * Третий шаг: сервер смотрит, что действительно легло в хранилище,
 * и только после этого файл становится `ready`. До подтверждения он
 * наружу не отдаётся ни одним способом.
 */
export const POST = apiRoute<{ id: string }>(async (request, { requestId, params }) => {
  const actor = await requireApiActor(request, requestId);
  const file = await completeUpload(actor, params.id);

  return apiJson(fileResource(file), requestId);
});
