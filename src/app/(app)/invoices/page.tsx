import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { listResidencies } from '@/db/repositories/residencies';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentSession } from '@/lib/session';
import { startOfMonth, todayInAlmaty, tryParseBusinessDate } from '@/lib/time';
import { listInvoicesFor, readInvoice } from '@/services/invoices';
import { readProfile } from '@/services/resident-profiles';

import {
  CreateInvoiceForm,
  HouseInvoicesTable,
  ResidentInvoices,
  SummaryCard,
  type InvoiceCardView,
  type InvoiceRowView,
  type ResidencyOption,
} from './invoice-views';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Счета (docs/03-BUSINESS-RULES.md §3, docs/04-MODULES/02-places-and-payments.md).
 *
 * Жилец видит свои счета карточками — со строками, статусом и историей
 * платежей. Админ видит таблицу дома за месяц со сводкой: деньги дома
 * читаются одним взглядом, а не сложением карточек.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string; month?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('invoices');
  const { context } = session;
  const actor: UserActor = { context };
  const isManager = context.role === 'admin' || context.role === 'superadmin';

  const header = (
    <div className="flex flex-col gap-1">
      <h1>{t('title')}</h1>
      <p className="text-text-muted text-[13px]">
        {isManager ? t('adminSubtitle') : t('subtitle')}
      </p>
    </div>
  );

  if (!isManager) {
    const rows = await listInvoicesFor(actor, {});
    const cards: InvoiceCardView[] = await Promise.all(
      rows.map(async (row) => {
        const view = await readInvoice(actor, row.invoice.id);

        return {
          id: view.invoice.id,
          type: view.invoice.type,
          status: view.invoice.status,
          periodMonth: view.invoice.periodMonth,
          dueDate: view.invoice.dueDate,
          total: view.invoice.total,
          paid: view.paid,
          remaining: view.remaining,
          overdue: view.overdue,
          residentName: null,
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
      }),
    );

    return (
      <section className="flex flex-col gap-6">
        {header}
        <ResidentInvoices invoices={cards} />
      </section>
    );
  }

  /*
   * Суперадмин не привязан к дому: таблица открывается по конкретному дому.
   * Сравнение домов между собой — дело дэшборда суперадмина (модуль 9, фаза 6),
   * а не таблицы счетов.
   */
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

  // Месяц счёта — всегда первое число (§3), какую бы дату ни передали ссылкой.
  const month = startOfMonth(tryParseBusinessDate(requestedMonth ?? '') ?? todayInAlmaty());

  const [rows, residencies] = await Promise.all([
    listInvoicesFor(actor, { houseId, periodMonth: month }),
    listResidencies(context, { houseId, status: 'active' }),
  ]);

  /** Имена вместо идентификаторов: таблицу счетов читает человек. */
  const nameOf = new Map<string, string>();
  for (const residency of residencies) {
    const profile = await readProfile(actor, residency.userId);
    const name = [profile.lastName, profile.firstName]
      .filter((part) => part !== null && part !== '')
      .join(' ');
    nameOf.set(residency.userId, name.trim() === '' ? residency.userId : name);
  }

  const tableRows: InvoiceRowView[] = rows.map((row) => ({
    id: row.invoice.id,
    residentName: nameOf.get(row.invoice.userId) ?? row.invoice.userId,
    periodMonth: row.invoice.periodMonth,
    status: row.invoice.status,
    total: row.invoice.total,
    paid: row.paid,
    remaining: row.remaining,
    overdue: row.overdue,
  }));

  // Отменённый счёт в сводку не входит: он не выставлен и не ждёт денег.
  const counted = rows.filter((row) => row.invoice.status !== 'cancelled');
  const summary = {
    issued: counted.reduce((sum, row) => sum + row.invoice.total, 0),
    paid: counted.reduce((sum, row) => sum + row.paid, 0),
    debt: counted.reduce((sum, row) => sum + row.remaining, 0),
  };

  const options: ResidencyOption[] = residencies.map((residency) => ({
    id: residency.id,
    name: nameOf.get(residency.userId) ?? residency.userId,
  }));

  return (
    <section className="flex flex-col gap-6">
      {header}

      {houses.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-[13px]">
          {houses.map((house) => (
            <Link
              className={
                house.id === houseId ? 'text-text font-medium' : 'text-text-muted hover:text-text'
              }
              href={{ pathname: '/invoices', query: { house: house.id, month } }}
              key={house.id}
            >
              {house.name}
            </Link>
          ))}
        </nav>
      )}

      <nav className="flex flex-wrap gap-2 text-[13px]">
        <Link className="text-text-muted hover:text-text" href="/invoices/remote">
          {t('remote.title')}
        </Link>
      </nav>

      <SummaryCard summary={summary} />
      <HouseInvoicesTable rows={tableRows} />

      {options.length > 0 && <CreateInvoiceForm residencies={options} />}
    </section>
  );
}
