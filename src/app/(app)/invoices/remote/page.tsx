import { AppLink } from '@/components/ui/app-link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentSession } from '@/lib/session';
import { addMonths, startOfMonth, todayInAlmaty, tryParseBusinessDate } from '@/lib/time';
import { listRemoteTasks } from '@/services/remote';
import { readProfile } from '@/services/resident-profiles';

import { RemoteList, type RemoteTaskView } from './remote-list';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * «Удалёнка» (docs/03-BUSINESS-RULES.md §3.1).
 *
 * Список задач админа: кому отправить счёт в Kaspi и от кого ждать перевода.
 * Способ оплаты берётся из профиля жильца — у счёта способа нет, он
 * появляется у платежа, а платежа ещё не было.
 */
export default async function RemotePage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string; month?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('invoices.remote');
  const { context } = session;
  const actor: UserActor = { context };

  const header = (
    <div className="flex flex-col gap-1">
      <AppLink className="text-text-muted text-[13px] hover:underline" href="/invoices">
        {(await getTranslations('invoices'))('backToList')}
      </AppLink>
      <h1>{t('title')}</h1>
      <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
    </div>
  );

  if (context.role === 'resident') {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState description={t('residentHint')} title={t('residentTitle')} />
      </section>
    );
  }

  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const { house: requested, month: requestedMonth } = await searchParams;

  const houseId =
    context.role === 'superadmin' ? (requested ?? houses[0]?.id ?? null) : context.houseId;

  if (houseId === null) {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState description={t('noHouseHint')} title={t('noHouse')} />
      </section>
    );
  }

  const month = startOfMonth(tryParseBusinessDate(requestedMonth ?? '') ?? todayInAlmaty());
  const tasks = await listRemoteTasks(actor, { houseId, periodMonth: month });

  const rows: RemoteTaskView[] = await Promise.all(
    tasks.map(async (task) => {
      const profile = await readProfile(actor, task.invoice.userId);
      const name = [profile.lastName, profile.firstName]
        .filter((part) => part !== null && part !== '')
        .join(' ');

      return {
        invoiceId: task.invoice.id,
        residentName: name.trim() === '' ? task.invoice.userId : name,
        periodMonth: task.invoice.periodMonth,
        dueDate: task.invoice.dueDate,
        total: task.invoice.total,
        remaining: task.remaining,
        overdue: task.overdue,
        sent: task.sent,
      };
    }),
  );

  const months = [0, 1, 2].map((back) => addMonths(startOfMonth(todayInAlmaty()), -back));

  return (
    <section className="flex flex-col gap-6">
      {header}

      {houses.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-[13px]">
          {houses.map((house) => (
            <AppLink
              className={
                house.id === houseId ? 'text-text font-medium' : 'text-text-muted hover:text-text'
              }
              href={{ pathname: '/invoices/remote', query: { house: house.id, month } }}
              key={house.id}
            >
              {house.name}
            </AppLink>
          ))}
        </nav>
      )}

      <nav className="flex flex-wrap gap-2 text-[13px]">
        {months.map((value) => (
          <AppLink
            className={
              value === month ? 'text-text font-medium' : 'text-text-muted hover:text-text'
            }
            href={{
              pathname: '/invoices/remote',
              query: { month: value, ...(houses.length > 1 ? { house: houseId } : {}) },
            }}
            key={value}
          >
            {value.slice(0, 7)}
          </AppLink>
        ))}
      </nav>

      <RemoteList tasks={rows} />
    </section>
  );
}
