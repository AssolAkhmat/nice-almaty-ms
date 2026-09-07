import { NotFoundError } from '@/lib/errors';
import { assertCronSecret } from '@/lib/api/cron';
import { apiJson, apiRoute } from '@/lib/api/route';
import { loadEnv } from '@/lib/env/load';
import { checkCurfew, CURFEW_CHECK_JOB } from '@/services/curfew';
import {
  DEPOSIT_REFUND_WATCH_JOB,
  DOCUMENTS_EXPIRY_JOB,
  watchDepositRefunds,
  watchDocumentExpiry,
} from '@/services/expiry-reminders';
import { generateMonthlyInvoices, MONTHLY_INVOICES_JOB } from '@/services/monthly-invoices';
import {
  remindSchedule,
  remindUtilities,
  SCHEDULE_REMIND_JOB,
  UTILITIES_REMIND_JOB,
} from '@/services/monthly-reminders';
import { dispatchNotifications, NOTIFICATIONS_DISPATCH_JOB } from '@/services/notifications';
import { RATING_YEAR_RESET_JOB, resetRatingYear } from '@/services/rating-year';
import { closeRotationDay, ROTATIONS_CLOSE_DAY_JOB } from '@/services/rotation-close-day';
import { remindRotations, ROTATIONS_REMIND_JOB } from '@/services/rotation-reminders';

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
  [NOTIFICATIONS_DISPATCH_JOB]: () => dispatchNotifications(),
  [ROTATIONS_REMIND_JOB]: () => remindRotations(),
  [CURFEW_CHECK_JOB]: () => checkCurfew(),
  [UTILITIES_REMIND_JOB]: () => remindUtilities(),
  [SCHEDULE_REMIND_JOB]: () => remindSchedule(),
  [DOCUMENTS_EXPIRY_JOB]: () => watchDocumentExpiry(),
  [DEPOSIT_REFUND_WATCH_JOB]: () => watchDepositRefunds(),
};

export const POST = apiRoute<{ job: string }>(async (request, { params, requestId }) => {
  assertCronSecret(request, loadEnv().CRON_SECRET);

  const handler = HANDLERS[params.job];

  if (handler === undefined) {
    throw new NotFoundError('Задание не найдено');
  }

  return apiJson({ job: params.job, result: await handler() }, requestId);
});
