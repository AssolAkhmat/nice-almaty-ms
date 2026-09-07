import { AppLink } from '@/components/ui/app-link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { readInvoice } from '@/services/invoices';
import { readProfile } from '@/services/resident-profiles';

import { InvoiceCard, PaymentForm, type InvoiceCardView } from '../invoice-views';
import { InvoiceEditor, type EditableLine } from './invoice-editor';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Карточка счёта: строки, платежи и всё, что с ним можно сделать
 * (docs/04-MODULES/02-places-and-payments.md, «Счета»).
 *
 * Жилец сюда тоже заходит — по ссылке из своего списка — и видит счёт
 * без управления: правка строк и отметка оплаты ему не положены.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('invoices');
  const { context } = session;
  const actor: UserActor = { context };
  const { id } = await params;

  const view = await readInvoice(actor, id);

  const profile = await readProfile(actor, view.invoice.userId);
  const name = [profile.lastName, profile.firstName]
    .filter((part) => part !== null && part !== '')
    .join(' ');

  const card: InvoiceCardView = {
    id: view.invoice.id,
    type: view.invoice.type,
    status: view.invoice.status,
    periodMonth: view.invoice.periodMonth,
    dueDate: view.invoice.dueDate,
    total: view.invoice.total,
    paid: view.paid,
    remaining: view.remaining,
    overdue: view.overdue,
    residentName: name.trim() === '' ? null : name,
    lines: view.lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      title: line.title,
      amount: line.amount,
    })),
    payments: view.payments.map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      method: payment.method,
      paidAt: payment.paidAt.toISOString(),
      note: payment.note,
    })),
  };

  const target = { houseId: view.invoice.houseId, userId: view.invoice.userId };
  const canIssue = can(context, 'invoice.issue', target);
  const canPay = can(context, 'payment.record', target);

  const closed = view.invoice.status === 'paid' || view.invoice.status === 'cancelled';

  const lines: EditableLine[] = view.lines.map((line) => ({
    kind: line.kind,
    title: line.title,
    amount: line.amount,
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <AppLink className="text-text-muted text-[13px] hover:underline" href="/invoices">
          {t('backToList')}
        </AppLink>
        <h1>{card.residentName ?? t('title')}</h1>
      </div>

      <InvoiceCard invoice={card} />

      {canIssue && (
        <InvoiceEditor
          cancellable={view.paid === 0 && view.invoice.status !== 'cancelled'}
          editable={!closed}
          invoiceId={view.invoice.id}
          lines={lines}
          recalculable={view.invoice.type === 'monthly' && !closed}
        />
      )}

      {canPay && view.remaining > 0 && view.invoice.status !== 'cancelled' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('recordPayment')}</CardTitle>
          </CardHeader>
          <div className="p-4 pt-0">
            <PaymentForm invoiceId={view.invoice.id} remaining={view.remaining} />
          </div>
        </Card>
      )}
    </section>
  );
}
