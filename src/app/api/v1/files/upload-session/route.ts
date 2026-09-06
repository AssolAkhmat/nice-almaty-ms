import { z } from 'zod';

import { ValidationError } from '@/lib/errors';
import { apiJson, apiRoute, requireApiActor } from '@/lib/api/route';
import { createUploadSession } from '@/services/files';

/**
 * Первый шаг двухшаговой загрузки (D4): права, тип и размер проверяются
 * до того, как байты куда-либо пойдут. Ответ содержит адрес, по которому
 * их ждут, — свой у каждого драйвера хранилища.
 */
const bodySchema = z.object({
  residency_id: z.uuid(),
  document_type: z.string().min(1).max(64),
  mime: z.string().min(1).max(128),
  size_bytes: z.number().int().positive(),
  original_name: z.string().min(1).max(255),
});

export const POST = apiRoute(async (request, { requestId }) => {
  const actor = await requireApiActor(request, requestId);

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new ValidationError('files.invalidBody', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
  }

  const session = await createUploadSession(actor, {
    residencyId: parsed.data.residency_id,
    documentType: parsed.data.document_type,
    mime: parsed.data.mime,
    sizeBytes: parsed.data.size_bytes,
    originalName: parsed.data.original_name,
  });

  return apiJson(
    {
      file_id: session.fileId,
      upload: session.upload,
      max_bytes: session.maxBytes,
    },
    requestId,
    201,
  );
});
