import type { FileRecord } from '@/db/schema';

/**
 * Представление файла наружу: snake_case (docs/06-API.md, «Соглашения»).
 *
 * Путь в хранилище и идентификатор объекта у провайдера не отдаются:
 * снаружи файл существует только как `id`, по которому проверяются права.
 */
export function fileResource(file: FileRecord) {
  return {
    id: file.id,
    residency_id: file.residencyId,
    status: file.status,
    mime: file.mime,
    size_bytes: file.sizeBytes,
    original_name: file.originalName,
    checksum: file.checksum,
    created_at: file.createdAt.toISOString(),
  };
}
