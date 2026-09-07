import { NotFoundError } from '@/lib/errors';
import { assertCronSecret } from '@/lib/api/cron';
import { apiJson, apiRoute } from '@/lib/api/route';
import { loadEnv } from '@/lib/env/load';
import { generateMonthlyInvoices, MONTHLY_INVOICES_JOB } from '@/services/monthly-invoices';
import { RATING_YEAR_RESET_JOB, resetRatingYear } from '@/services/rating-year';
import { closeRotationDay, ROTATIONS_CLOSE_DAY_JOB } from '@/services/rotation-close-day';

/**
 * Задания планировщика (docs/01-ARCHITECTURE.md, «Планировщик»).
 *
 * Задание — обычный HTTP-эндпоинт с заголовком `x-cron-secret`: так его
 * дёргают и раннер в Docker, и расписание Vercel, и человек руками при
 * разборе сбоя. Идемпотентность обеспечивают сами задания через `job_runs`,
 * поэтому повторный вызов безопасен.
 */
type JobHandler = () => Promise<unknown>;

const HANDLERS: Readonly<Record<string, JobHandler>> = {
  [MONTHLY_INVOICES_JOB]: () => generateMonthlyInvoices(),
  [ROTATIONS_CLOSE_DAY_JOB]: () => closeRotationDay(),
  [RATING_YEAR_RESET_JOB]: () => resetRatingYear(),
};

export const POST = apiRoute<{ job: string }>(async (request, { params, requestId }) => {
  assertCronSecret(request, loadEnv().CRON_SECRET);

  const handler = HANDLERS[params.job];

  if (handler === undefined) {
    throw new NotFoundError('Задание не найдено');
  }

  return apiJson({ job: params.job, result: await handler() }, requestId);
});
