import { MAX_UPLOAD_BYTES } from '@/domain/files';
import { ValidationError } from '@/lib/errors';
import { apiJson, apiRoute, requireApiActor } from '@/lib/api/route';
import { fileResource } from '@/lib/api/file-resource';
import { receiveUploadedBytes } from '@/services/files';

/**
 * Второй шаг для драйверов без прямого адреса: байты принимает приложение.
 * У Google Drive и Supabase этого шага не будет — там клиент пишет прямо
 * в хранилище, и лимит тела запроса на Vercel (D4) обходится сам собой.
 */
export const PUT = apiRoute<{ id: string }>(async (request, { requestId, params }) => {
  const actor = await requireApiActor(request, requestId);

  // Заявленная длина отвергается до чтения тела: качать десятки мегабайт,
  // чтобы затем их выбросить, — подарок тому, кто это делает нарочно.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new ValidationError('files.tooLarge', { maxBytes: MAX_UPLOAD_BYTES });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ValidationError('files.tooLarge', { maxBytes: MAX_UPLOAD_BYTES });
  }

  const file = await receiveUploadedBytes(actor, params.id, bytes);

  return apiJson(fileResource(file), requestId);
});
