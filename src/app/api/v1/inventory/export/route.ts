import { ValidationError } from '@/lib/errors';
import { apiRoute, requireApiActor } from '@/lib/api/route';
import { exportInventory, type ExportFormat } from '@/services/inventory-audit';

/**
 * Выгрузка инвентаря дома в CSV или XLSX
 * (docs/04-MODULES/10-accounting-inventory.md, «Инвентарь»).
 *
 * Файл собирается сервисом и уходит вложением. Права проверяются те же,
 * что и на экране: выгрузка не должна открывать то, чего человек не видит.
 */
function isFormat(value: string | null): value is ExportFormat {
  return value === 'csv' || value === 'xlsx';
}

export const GET = apiRoute(async (request, { requestId }) => {
  const actor = await requireApiActor(request, requestId);
  const url = new URL(request.url);

  const houseId = url.searchParams.get('house');
  const format = url.searchParams.get('format') ?? 'csv';

  if (houseId === null || houseId === '') {
    throw new ValidationError('inventory.errors.houseRequired');
  }

  if (!isFormat(format)) {
    throw new ValidationError('inventory.errors.format');
  }

  const file = await exportInventory(actor, houseId, format);
  const body = typeof file.body === 'string' ? file.body : new Uint8Array(file.body);

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': file.mime,
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'private, no-store',
      'x-request-id': requestId,
    },
  });
});
