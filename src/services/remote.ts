import { getDb, type Executor } from '@/db/client';
import { requireInvoice, updateInvoice } from '@/db/repositories/invoices';
import { listPreferredPayments } from '@/db/repositories/resident-profiles';
import { requireResidency } from '@/db/repositories/residencies';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { listInvoicesFor, type InvoiceRow } from './invoices';

import type { InvoiceFilter } from '@/db/repositories/invoices';
import type { Invoice } from '@/db/schema';
import type { UserActor } from './users';

/**
 * «Удалёнка» (docs/03-BUSINESS-RULES.md §3.1,
 * docs/04-MODULES/02-places-and-payments.md).
 *
 * Не отдельная сущность, а вопрос к уже существующим счетам: кому нужно
 * отправить счёт в Kaspi и от кого ждать перевода. Поэтому здесь нет ни
 * своей таблицы, ни своего статуса — только выборка и отметка отправки.
 *
 * Способ оплаты берётся из профиля жильца (`preferred_payment`): у счёта
 * способа нет и быть не может, он появляется у платежа, а платежа ещё нет.
 */
export interface RemoteDeps {
  executor?: Executor;
  today?: BusinessDate;
  instant?: Date;
}

function resolve(deps: RemoteDeps): { executor: Executor; today: BusinessDate; instant: Date } {
  const instant = deps.instant ?? now();

  return {
    executor: deps.executor ?? getDb(),
    today: deps.today ?? todayInAlmaty(instant),
    instant,
  };
}

export interface RemoteTask extends InvoiceRow {
  /** Счёт уже отправлен жильцу: остаётся дождаться перевода. */
  sent: boolean;
}

export type RemoteFilter = Pick<InvoiceFilter, 'houseId' | 'periodMonth'>;

/**
 * Задачи админа: счета, по которым ещё ждут перевода от жильцов с Kaspi.
 * Оплаченный и отменённый счёт выпадают сами — ждать по ним нечего.
 */
export async function listRemoteTasks(
  actor: UserActor,
  filter: RemoteFilter,
  deps: RemoteDeps = {},
): Promise<RemoteTask[]> {
  const { executor } = resolve(deps);

  const rows = await listInvoicesFor(actor, filter, deps);

  const open = rows.filter(
    (row) =>
      row.remaining > 0 &&
      row.invoice.status !== 'cancelled' &&
      row.invoice.type !== 'deposit_refund',
  );

  const preferred = await listPreferredPayments(
    actor.context,
    [...new Set(open.map((row) => row.invoice.userId))],
    executor,
  );

  return open
    .filter((row) => preferred.get(row.invoice.userId) === 'kaspi')
    .map((row) => ({ ...row, sent: row.invoice.remoteSentAt !== null }));
}

/**
 * «Счёт отправлен» (§3.1): запоминается момент отправки, статус счёта
 * не меняется. Отправка — не оплата: деньги придут переводом, и отметить
 * их обязан тот, кто их увидел.
 */
export async function markInvoiceSent(
  actor: UserActor,
  invoiceId: string,
  deps: RemoteDeps = {},
): Promise<Invoice> {
  const { executor, instant } = resolve(deps);

  const invoice = await requireInvoice(actor.context, invoiceId, executor);
  const residency = await requireResidency(actor.context, invoice.residencyId, executor);

  assertCan(actor.context, 'invoice.issue', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  if (invoice.status === 'cancelled' || invoice.status === 'paid') {
    throw new ConflictError('invoices.errors.closed');
  }

  if (invoice.remoteSentAt !== null) {
    throw new ConflictError('invoices.errors.alreadySent');
  }

  return executor.transaction(async (tx) => {
    const updated = await updateInvoice(actor.context, invoice.id, { remoteSentAt: instant }, tx);

    if (updated === null) {
      throw new NotFoundError('Счёт не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.invoiceSentRemotely,
        entityType: 'invoice',
        entityId: invoice.id,
        after: { remoteSentAt: instant.toISOString() },
      },
      tx,
    );

    return updated;
  });
}
