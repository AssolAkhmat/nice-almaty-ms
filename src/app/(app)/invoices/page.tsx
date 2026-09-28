import { AppLink } from '@/components/ui/app-link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { listResidencies } from '@/db/repositories/residencies';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentSession } from '@/lib/session';
import {
  addMonths,
  parseBusinessDate,
  startOfMonth,
  todayInAlmaty,
  tryParseBusinessDate,
} from '@/lib/time';
import { listInvoicesFor, readInvoice } from '@/services/invoices';
import { listUtilityReceiptsFor, readUtilityShareFor } from '@/services/utilities';
import { optionLabel, personLabels } from '@/services/person-labels';
import { houseHistoryNames } from '@/services/residents';

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

        /*
         * Чеки коммуналки за месяц, к которому относится строка счёта
         * (указание владельца, 25 сентября 2026). Коммуналка идёт за
         * предыдущий месяц (§3), и чеки берутся у закрытого периода дома.
         */
        const utilityMonth =
          view.invoice.periodMonth === null
            ? null
            : addMonths(parseBusinessDate(view.invoice.periodMonth), -1);

        const receipts =
          utilityMonth === null
            ? []
            : await listUtilityReceiptsFor(actor, { userId: context.userId, month: utilityMonth });

        /*
         * Раскладка доли: сутки, по которым посчитано, и знаменатель дома
         * (Приложение №3 п. 4.4). До этого в счёте была одна сумма, и жилец
         * не мог проверить по ней ничего (находка P2-6, 27 сентября 2026).
         */
        const share =
          utilityMonth === null
            ? null
            : await readUtilityShareFor(actor, { userId: context.userId, month: utilityMonth });

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
            ...(line.kind === 'utilities'
              ? {
                  receipts,
                  ...(share === null
                    ? {}
                    : {
                        breakdown: {
                          days: share.days,
                          totalDays: share.totalDays,
                          total: share.total,
                          houseDays: share.houseDays,
                          houseAmount: share.houseAmount,
                        },
                      }),
                }
              : {}),
          })),
          payments: view.payments.map((payment) => ({
            id: payment.id,
            amount: payment.amount,
            method: payment.method,
            paidAt: payment.paidAt.toISOString(),
            note: payment.note,
            receiptFileId: payment.receiptFileId,
            isReversal: payment.reversesPaymentId !== null,
            isReversed: view.payments.some((other) => other.reversesPaymentId === payment.id),
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

  /*
   * Подпись человека строит один сервис (`personLabels`): страница собирала
   * имя сама и на незаполненном профиле кладла в строку пустую строку —
   * ссылка на карточку счёта выходила без текста, и дороги к отметке оплаты
   * не оставалось (находка P1-4, 27 сентября 2026).
   */
  /*
   * Подписи нужны и владельцам счетов месяца, и всем действующим жильцам дома:
   * из вторых собирается список формы ручного счёта.
   *
   * Сначала здесь брались только владельцы счетов, и жилец без счёта за этот
   * месяц попадал в список формы **пустой строкой**: выбрать его было нельзя
   * ни человеку, ни приёмке. Прогон приёмок это назвал, а `pnpm verify` — нет:
   * пустая строка в `<option>` типы не ломает (разбор 28 сентября 2026).
   */
  const userIds = [
    ...new Set([
      ...rows.map((row) => row.invoice.userId),
      ...residencies.map((residency) => residency.userId),
    ]),
  ];

  const labels = await personLabels(context, userIds);

  const nameOf = new Map<string, string>();

  for (const [userId, label] of labels) {
    if (label.name !== null) {
      nameOf.set(userId, label.name);
    }
  }

  const missing = userIds.filter((userId) => !nameOf.has(userId));

  for (const [userId, name] of await houseHistoryNames(actor, houseId, missing)) {
    if (name.trim() !== '') {
      nameOf.set(userId, name);
    }
  }

  const tableRows: InvoiceRowView[] = rows.map((row) => ({
    id: row.invoice.id,
    resident: {
      name: nameOf.get(row.invoice.userId) ?? null,
      phone: labels.get(row.invoice.userId)?.phone ?? '',
    },
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

  /*
   * Без имени в списке стоит телефон, а не пустая строка: профиль может быть
   * ещё не заполнен, а счёт такому жильцу выставляют — например, на депозит.
   */
  const options: ResidencyOption[] = residencies.map((residency) => ({
    id: residency.id,
    name: optionLabel(labels.get(residency.userId), residency.id),
  }));

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
              href={{ pathname: '/invoices', query: { house: house.id, month } }}
              key={house.id}
            >
              {house.name}
            </AppLink>
          ))}
        </nav>
      )}

      <nav className="flex flex-wrap gap-2 text-[13px]">
        <AppLink className="text-text-muted hover:text-text" href="/invoices/remote">
          {t('remote.title')}
        </AppLink>
      </nav>

      <SummaryCard summary={summary} />
      <HouseInvoicesTable rows={tableRows} />

      {options.length > 0 && <CreateInvoiceForm residencies={options} />}
    </section>
  );
}
