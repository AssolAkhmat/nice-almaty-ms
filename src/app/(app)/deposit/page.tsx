import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listResidencies } from '@/db/repositories/residencies';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentSession } from '@/lib/session';
import { todayInAlmaty } from '@/lib/time';
import { readDepositView } from '@/services/deposits';
import { personLabels, type PersonLabel } from '@/services/person-labels';

import { DepositList, DepositScreen, type DepositScreenView } from './deposit-view';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Депозит (docs/04-MODULES/01-onboarding.md, «Депозит»).
 *
 * Жилец видит остаток и движение за год. Админ видит то же по каждому
 * проживанию своего дома и может выставить счёт и отметить платёж:
 * деньги приходят не через приложение, и получение подтверждает тот,
 * кто их получил.
 */
async function viewFor(
  actor: UserActor,
  residencyId: string,
  canManage: boolean,
  labels: ReadonlyMap<string, PersonLabel>,
): Promise<DepositScreenView> {
  const view = await readDepositView(actor, residencyId);

  /*
   * Подпись берётся общей функцией: раньше при пустом профиле здесь
   * подставлялся идентификатор проживания, и на экране стоял uuid вместо
   * человека. Идентификатор человеку не нужен нигде.
   */
  const label = labels.get(view.residency.userId) ?? null;

  return {
    residencyId: view.residency.id,
    resident: label === null ? null : { name: label.name, phone: label.phone },
    balance: view.balance,
    // Движение показывается за текущий год по календарю Алматы (§8).
    year: Number(todayInAlmaty().slice(0, 4)),
    movements: view.transactions.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount,
      note: transaction.note,
      createdAt: transaction.createdAt.toISOString(),
      participants: view.participantsOf[transaction.id] ?? null,
      receiptFileId: view.receiptOf[transaction.id] ?? null,
    })),
    invoice:
      view.invoice === null
        ? null
        : {
            id: view.invoice.id,
            total: view.invoice.total,
            paid: view.invoice.paid,
            remaining: view.invoice.remaining,
            status: view.invoice.status,
          },
    canManage,
  };
}

export default async function DepositPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('deposit');
  const { context } = session;
  const actor: UserActor = { context };

  const canManage = context.role === 'admin' || context.role === 'superadmin';
  const residencies = await listResidencies(context, {});

  /*
   * Подписи читаются одним запросом на весь список: N запросов на N жильцов
   * и раньше были лишними, а с подписью стали бы заметными.
   */
  const labels = canManage
    ? await personLabels(
        context,
        residencies.map((residency) => residency.userId),
      )
    : new Map<string, PersonLabel>();

  const views = await Promise.all(
    residencies.map((residency) => viewFor(actor, residency.id, canManage, labels)),
  );

  const [own] = views;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">
          {canManage ? t('adminSubtitle') : t('subtitle')}
        </p>
      </div>

      {canManage ? (
        <DepositList views={views} />
      ) : own === undefined ? (
        <EmptyState description={t('noResidencyHint')} title={t('noResidency')} />
      ) : (
        <DepositScreen view={own} />
      )}
    </section>
  );
}
