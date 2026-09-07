import { assertApiAccess } from '@/lib/api/access';
import { apiJson, apiRoute, requireApiActor } from '@/lib/api/route';
import { tryParseBusinessDate } from '@/lib/time';
import { listInvoicesFor } from '@/services/invoices';

/**
 * Счета (docs/06-API.md, `GET /invoices`).
 *
 * Деньги — отдельный скоуп: токен на места счета не откроет, даже если
 * выдал его суперадмин. Это и есть смысл скоупа — сузить ключ до той
 * части, ради которой бот заводился.
 */
export const GET = apiRoute(async (request, { requestId }) => {
  const actor = await requireApiActor(request, requestId);

  const url = new URL(request.url);
  const houseId = url.searchParams.get('house_id');
  const month = tryParseBusinessDate(url.searchParams.get('month') ?? '');

  assertApiAccess(actor, 'invoice.read', {
    houseId: houseId ?? actor.context.houseId,
    userId: actor.context.userId,
  });

  const rows = await listInvoicesFor(actor, {
    ...(houseId === null || houseId === '' ? {} : { houseId }),
    ...(month === null ? {} : { periodMonth: month }),
  });

  return apiJson(
    {
      data: rows.map((row) => ({
        id: row.invoice.id,
        user_id: row.invoice.userId,
        house_id: row.invoice.houseId,
        type: row.invoice.type,
        status: row.invoice.status,
        period_month: row.invoice.periodMonth,
        due_date: row.invoice.dueDate,
        total: row.invoice.total,
        paid: row.paid,
        remaining: row.remaining,
        overdue: row.overdue,
      })),
    },
    requestId,
  );
});
