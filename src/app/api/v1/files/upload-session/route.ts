import { z } from 'zod';

import { ValidationError } from '@/lib/errors';
import { apiJson, apiRoute, requireApiActor } from '@/lib/api/route';
import { createHouseUploadSession, createUploadSession } from '@/services/files';

/**
 * Первый шаг двухшаговой загрузки (D4): права, тип и размер проверяются
 * до того, как байты куда-либо пойдут. Ответ содержит адрес, по которому
 * их ждут, — свой у каждого драйвера хранилища.
 */
const commonSchema = {
  mime: z.string().min(1).max(128),
  size_bytes: z.number().int().positive(),
  original_name: z.string().min(1).max(255),
};

/**
 * Владелец файла — либо проживание (документ жильца), либо дом (чек
 * к ущербу, расходу, коммуналке). Два разных владельца — две разные
 * проверки прав, поэтому и тело запроса разное, а не «одно с пустыми полями».
 */
const bodySchema = z.union([
  z.object({
    residency_id: z.uuid(),
    document_type: z.string().min(1).max(64),
    ...commonSchema,
  }),
  z.object({
    /** `null` — чек уровня сети: у расхода с общего счёта дома нет. */
    house_id: z.uuid().nullable(),
    purpose: z.string().min(1).max(64),
    ...commonSchema,
  }),
]);

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

  const body = parsed.data;

  const session =
    'residency_id' in body
      ? await createUploadSession(actor, {
          residencyId: body.residency_id,
          documentType: body.document_type,
          mime: body.mime,
          sizeBytes: body.size_bytes,
          originalName: body.original_name,
        })
      : await createHouseUploadSession(actor, {
          houseId: body.house_id,
          purpose: body.purpose,
          mime: body.mime,
          sizeBytes: body.size_bytes,
          originalName: body.original_name,
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
