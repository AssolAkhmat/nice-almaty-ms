import { getDb, type Executor } from '@/db/client';
import {
  createLedgerEntry,
  listAccounts,
  listLedgerEntries,
  listLinesOfEntries,
  requireAccount,
  type LedgerFilter,
} from '@/db/repositories/accounts';
import { kaspiTotals } from '@/db/repositories/invoices';
import { listHouses } from '@/db/repositories/houses';
import { ACCOUNT_CODES } from '@/db/schema';
import { ACQUIRING_RATE_BP, TAX_RATE_BP, taxReport, type TaxReport } from '@/domain/tax';
import { assertCan } from '@/lib/authz';
import { ValidationError } from '@/lib/errors';
import { startOfDayUtc, startOfNextDayUtc, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { requireAccountByCode } from './ledger';

import type { LedgerEntry, Payment } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Отчёты бухгалтерии и калькулятор налогов
 * (docs/03-BUSINESS-RULES.md §10, docs/04-MODULES/10-accounting-inventory.md).
 *
 * Книга проводок — дело суперадмина (§10.1), поэтому всё здесь стоит
 * на `accounting.read` и `accounting.write`, и админу дома не открывается.
 */
export interface AccountingDeps {
  executor?: Executor;
  today?: BusinessDate;
}

function resolve(deps: AccountingDeps): { executor: Executor; today: BusinessDate } {
  return { executor: deps.executor ?? getDb(), today: deps.today ?? todayInAlmaty() };
}

/** Категории расходов из модуля 10. Свои сюда не добавляются с экрана. */
export const EXPENSE_CATEGORIES = [
  'rent',
  'equipment',
  'chemicals',
  'depreciation',
  'repair',
  'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface ExpenseInput {
  category: string;
  amount: number;
  description: string;
  /** Счёт списания: фонд дома или общий счёт (§10.1). */
  accountId: string;
  /** Откуда физически ушли деньги. */
  paidFrom: Payment['method'];
  date?: BusinessDate | undefined;
  receiptFileId?: string | null | undefined;
}

export interface JournalLine {
  accountId: string;
  code: string;
  name: string;
  direction: 'debit' | 'credit';
  amount: number;
}

export interface JournalRow {
  entry: LedgerEntry;
  lines: JournalLine[];
}

export interface TaxTotals {
  kaspiIncome: number;
  kaspiTurnover: number;
}

export interface TaxByHouse {
  houseId: string;
  houseName: string;
  income: number;
  turnover: number;
  report: TaxReport;
}

export interface TaxView {
  from: BusinessDate;
  to: BusinessDate;
  taxRateBp: number;
  acquiringRateBp: number;
  totals: TaxTotals;
  report: TaxReport;
  byHouse: TaxByHouse[];
}

function isCategory(value: string): value is ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Расход (модуль 10): дебет фонда, кредит кассы или Kaspi (§10.1,
 * «Аренда, закупка, износ»). Отдельной таблицы у расходов нет — расход
 * и есть проводка, а категория живёт колонкой у неё же: два места хранения
 * одного и того же однажды разошлись бы.
 */
export async function recordExpense(
  actor: UserActor,
  input: ExpenseInput,
  deps: AccountingDeps = {},
): Promise<LedgerEntry> {
  const { executor, today } = resolve(deps);

  assertCan(actor.context, 'accounting.write');

  if (!isCategory(input.category)) {
    throw new ValidationError('accounting.errors.category');
  }

  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new ValidationError('accounting.errors.amountInvalid');
  }

  if (input.description.trim() === '') {
    throw new ValidationError('accounting.errors.descriptionRequired');
  }

  const target = await requireAccount(actor.context, input.accountId, executor);
  const money = await requireAccountByCode(
    actor,
    input.paidFrom === 'kaspi' ? ACCOUNT_CODES.kaspi : ACCOUNT_CODES.cash,
    executor,
  );

  return executor.transaction(async (tx) => {
    const { entry } = await createLedgerEntry(
      actor.context,
      {
        entryDate: input.date ?? today,
        description: input.description.trim(),
        sourceType: 'expense',
        sourceId: input.receiptFileId ?? null,
        category: input.category,
        createdBy: actor.context.userId,
      },
      [
        { accountId: target.id, direction: 'debit', amount: input.amount },
        { accountId: money.id, direction: 'credit', amount: input.amount },
      ],
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.expenseRecorded,
        entityType: 'ledger_entry',
        entityId: entry.id,
        after: {
          category: input.category,
          amount: input.amount,
          account: target.code,
          paidFrom: money.code,
        },
      },
      tx,
    );

    return entry;
  });
}

/**
 * Журнал проводок с фильтрами по счёту, дому, периоду и источнику
 * (модуль 10). Строки подтягиваются одной выборкой на весь журнал.
 */
export async function readLedgerJournal(
  actor: UserActor,
  filter: LedgerFilter = {},
  deps: AccountingDeps = {},
): Promise<JournalRow[]> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'accounting.read');

  const entries = await listLedgerEntries(actor.context, filter, executor);
  const lines = await listLinesOfEntries(
    entries.map((entry) => entry.id),
    executor,
  );

  const accounts = await listAccounts(actor.context, { includeArchived: true }, executor);
  const byId = new Map(accounts.map((account) => [account.id, account]));

  const byEntry = new Map<string, JournalLine[]>();

  for (const line of lines) {
    const account = byId.get(line.accountId);

    const row: JournalLine = {
      accountId: line.accountId,
      code: account?.code ?? line.accountId,
      name: account?.name ?? line.accountId,
      direction: line.direction,
      amount: line.amount,
    };

    byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), row]);
  }

  return entries.map((entry) => ({ entry, lines: byEntry.get(entry.id) ?? [] }));
}

export interface TaxRates {
  taxRateBp?: number | undefined;
  acquiringRateBp?: number | undefined;
}

/**
 * Калькулятор налогов (§10.2). Считает по платежам с методом `kaspi`:
 * это ровно те деньги, что прошли через эквайринг. Депозит в доход
 * не входит — он обязательство сети перед жильцом, а не выручка, —
 * но в оборот эквайринга входит: комиссия с него всё равно снята.
 *
 * Расчёт справочный и проводок не создаёт (§10.2). Кнопка «Провести
 * как расход» — обычный расход, заводится тем же путём, что и остальные.
 */
export async function readTaxReport(
  actor: UserActor,
  period: { from: BusinessDate; to: BusinessDate },
  deps: AccountingDeps = {},
  rates: TaxRates = {},
): Promise<TaxView> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'accounting.read');

  const taxRateBp = rates.taxRateBp ?? TAX_RATE_BP;
  const acquiringRateBp = rates.acquiringRateBp ?? ACQUIRING_RATE_BP;

  // Период включает последний день целиком: границы суток — по Алматы.
  const totalsByHouse = await kaspiTotals(
    actor.context,
    { from: startOfDayUtc(period.from), to: startOfNextDayUtc(period.to) },
    executor,
  );

  const houses = await listHouses(actor.context, { includeArchived: true }, executor);
  const nameOf = new Map(houses.map((house) => [house.id, house.name]));

  const totals: TaxTotals = {
    kaspiIncome: totalsByHouse.reduce((sum, row) => sum + row.income, 0),
    kaspiTurnover: totalsByHouse.reduce((sum, row) => sum + row.turnover, 0),
  };

  return {
    from: period.from,
    to: period.to,
    taxRateBp,
    acquiringRateBp,
    totals,
    report: taxReport({ ...totals, taxRateBp, acquiringRateBp }),
    byHouse: totalsByHouse.map((row) => ({
      houseId: row.houseId,
      houseName: nameOf.get(row.houseId) ?? row.houseId,
      income: row.income,
      turnover: row.turnover,
      report: taxReport({
        kaspiIncome: row.income,
        kaspiTurnover: row.turnover,
        taxRateBp,
        acquiringRateBp,
      }),
    })),
  };
}
