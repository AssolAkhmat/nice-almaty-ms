import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { AppLink } from '@/components/ui/app-link';
import { EmptyState } from '@/components/ui/empty-state';
import { listAccounts } from '@/db/repositories/accounts';
import { ACCOUNT_CODES } from '@/db/schema';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { addMonths, startOfMonth, todayInAlmaty, tryParseBusinessDate } from '@/lib/time';
import { readLedgerJournal, readTaxReport } from '@/services/accounting';
import { reconcileDepositFund, trialBalance } from '@/services/ledger';

import {
  ExpenseForm,
  Journal,
  Reconciliation,
  TaxCalculator,
  TrialBalance,
  type JournalRowView,
} from './accounting-views';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Бухгалтерия (docs/04-MODULES/10-accounting-inventory.md, §10).
 *
 * Книга проводок — дело суперадмина (§10.1): админ дома ведёт деньги
 * своего дома счетами и депозитами, а в проводки не смотрит.
 *
 * Инвентарь — фаза 6, здесь его нет.
 *
 * Ставка приходит процентами с двумя знаками, а хранится базисными пунктами:
 * 0,95 % числом с плавающей точкой рано или поздно даст 0,9499999.
 */
function rateFromPercent(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.round(parsed * 100);
}

function percentOf(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2);
}

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    taxRate?: string;
    acquiringRate?: string;
    source?: string;
  }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('accounting');
  const { context } = session;
  const actor: UserActor = { context };

  const header = (
    <div className="flex flex-col gap-1">
      <h1>{t('title')}</h1>
      <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
    </div>
  );

  if (!can(context, 'accounting.read')) {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState description={t('closedHint')} title={t('closed')} />
      </section>
    );
  }

  const params = await searchParams;
  const month = startOfMonth(todayInAlmaty());

  const from = tryParseBusinessDate(params.from ?? '') ?? month;
  const to = tryParseBusinessDate(params.to ?? '') ?? addMonths(month, 1);

  const taxRateBp = rateFromPercent(params.taxRate, 300);
  const acquiringRateBp = rateFromPercent(params.acquiringRate, 95);

  /*
   * План счетов читается первым: без депозитного фонда сверка и отчёты
   * бросают «счёт не заведён», и экран падал серверной ошибкой — ровно так
   * выглядела боевая база после инцидента I9. Пустой план — состояние,
   * а не поломка: экран говорит, чем его заполнить (T9.13).
   */
  const accounts = await listAccounts(context);

  if (!accounts.some((account) => account.code === ACCOUNT_CODES.depositFund)) {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState
          action={
            <AppLink className="text-primary hover:underline" href="/settings/accounts">
              {t('noAccountsLink')}
            </AppLink>
          }
          description={t('noAccountsHint')}
          title={t('noAccounts')}
        />
      </section>
    );
  }

  const [balances, reconciliation, journal, tax] = await Promise.all([
    trialBalance(actor, { from, to }),
    reconcileDepositFund(actor),
    readLedgerJournal(actor, {
      from,
      to,
      ...(params.source === undefined || params.source === '' ? {} : { sourceType: params.source }),
    }),
    readTaxReport(actor, { from, to }, {}, { taxRateBp, acquiringRateBp }),
  ]);

  const rows: JournalRowView[] = journal.map((row) => ({
    id: row.entry.id,
    date: row.entry.entryDate,
    description: row.entry.description,
    sourceType: row.entry.sourceType,
    category: row.entry.category,
    receiptFileId: row.entry.receiptFileId,
    reversed: row.entry.reversedByEntryId !== null,
    lines: row.lines.map((line) => ({
      code: line.code,
      name: line.name,
      direction: line.direction,
      amount: line.amount,
    })),
  }));

  /** Списывать расход можно на фонд дома или общий счёт (§10.1). */
  const writeOff = accounts.filter(
    (account) => account.type === 'house_fund' || account.type === 'common_fund',
  );

  return (
    <section className="flex flex-col gap-6">
      {header}

      <Reconciliation view={reconciliation} />
      <TrialBalance rows={balances} />

      <TaxCalculator
        view={{
          from,
          to,
          taxRatePercent: percentOf(taxRateBp),
          acquiringRatePercent: percentOf(acquiringRateBp),
          income: tax.totals.kaspiIncome,
          turnover: tax.totals.kaspiTurnover,
          tax: tax.report.tax,
          acquiring: tax.report.acquiring,
          deduction: tax.report.deduction,
          net: tax.report.net,
          byHouse: tax.byHouse.map((house) => ({
            houseId: house.houseId,
            houseName: house.houseName,
            income: house.income,
            turnover: house.turnover,
            tax: house.report.tax,
            acquiring: house.report.acquiring,
          })),
        }}
      />

      {can(context, 'accounting.write') && (
        <ExpenseForm
          accounts={writeOff.map((account) => ({
            id: account.id,
            name: account.name,
            houseId: account.houseId,
          }))}
        />
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-medium">{t('journal')}</h2>
        <Journal rows={rows} />
      </section>
    </section>
  );
}
