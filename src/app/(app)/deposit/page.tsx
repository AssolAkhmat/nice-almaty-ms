import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listResidencies } from '@/db/repositories/residencies';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentSession } from '@/lib/session';
import { todayInAlmaty } from '@/lib/time';
import { readDepositView } from '@/services/deposits';
import { readProfile } from '@/services/resident-profiles';

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
  withName: boolean,
): Promise<DepositScreenView> {
  const view = await readDepositView(actor, residencyId);

  let residentName: string | null = null;
  if (withName) {
    const profile = await readProfile(actor, view.residency.userId);
    const name = [profile.lastName, profile.firstName]
      .filter((part) => part !== null && part !== '')
      .join(' ');
    residentName = name.trim() === '' ? view.residency.userId : name;
  }

  return {
    residencyId: view.residency.id,
    residentName,
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

  const views = await Promise.all(
    residencies.map((residency) => viewFor(actor, residency.id, canManage, canManage)),
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
