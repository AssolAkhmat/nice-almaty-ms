import { getDb, type Executor } from '@/db/client';
import {
  accountBalances,
  createLedgerEntry,
  findAccountByCode,
  findLedgerEntry,
  listAccounts,
  listLedgerLines,
  markEntryReversed,
  requireAccount,
} from '@/db/repositories/accounts';
import { listDepositTransactions } from '@/db/repositories/invoices';
import { listResidencies } from '@/db/repositories/residencies';
import { depositBalance } from '@/domain/invoice';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { Account, LedgerEntry } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Двойная запись (docs/03-BUSINESS-RULES.md §10.1).
 *
 * Каждая операция — проводка с равными дебетом и кредитом (инвариант 3).
 * Проверка стоит здесь, а не в базе: правило учёта живёт в одном месте,
 * и нарушить его можно только мимо этого сервиса, чего в коде нет.
 *
 * Типовые проводки собраны здесь же: если бы каждая часть системы строила
 * свои строки, дебет и кредит однажды разъехались бы по смыслу, оставаясь
 * равными по сумме.
 */
export interface LedgerDeps {
  executor?: Executor;
  today?: BusinessDate;
}

function resolve(deps: LedgerDeps): { executor: Executor; today: BusinessDate } {
  return { executor: deps.executor ?? getDb(), today: deps.today ?? todayInAlmaty() };
}

/** Коды системных счетов. Фонд дома — свой у каждого дома, отсюда суффикс. */
export const ACCOUNT_CODES = {
  depositFund: 'deposit_fund',
  utilityFund: 'utility_fund',
  commonFund: 'common_fund',
  cash: 'cash',
  kaspi: 'kaspi',
} as const;

export function houseFundCode(houseSlug: string): string {
  return `house_fund:${houseSlug}`;
}

export interface PostLine {
  accountId: string;
  direction: 'debit' | 'credit';
  amount: number;
}

export interface PostEntryInput {
  description: string;
  /** Откуда операция: `deposit`, `damage`, `invoice`, `expense`, `manual`. */
  sourceType: string;
  sourceId?: string | null;
  date?: BusinessDate;
  lines: readonly PostLine[];
}

function assertBalanced(lines: readonly PostLine[]): void {
  if (lines.length < 2) {
    throw new ValidationError('accounting.errors.tooFewLines');
  }

  let debit = 0;
  let credit = 0;

  for (const line of lines) {
    // Сумма строки положительна: знак несёт направление, а не число.
    if (!Number.isSafeInteger(line.amount) || line.amount <= 0) {
      throw new ValidationError('accounting.errors.amountInvalid');
    }

    if (line.direction === 'debit') {
      debit += line.amount;
    } else {
      credit += line.amount;
    }
  }

  if (debit !== credit) {
    throw new ValidationError('accounting.errors.unbalanced');
  }
}

/**
 * Проводка целиком или никак. Счета проверяются на видимость до записи:
 * проводка по чужому счёту — не ошибка ввода, а выход за пределы сети.
 */
export async function postEntry(
  actor: UserActor,
  input: PostEntryInput,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  const { executor, today } = resolve(deps);

  assertCan(actor.context, 'accounting.write');
  assertBalanced(input.lines);

  for (const line of input.lines) {
    await requireAccount(actor.context, line.accountId, executor);
  }

  return executor.transaction(async (tx) => {
    const { entry } = await createLedgerEntry(
      actor.context,
      {
        entryDate: input.date ?? today,
        description: input.description,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        createdBy: actor.context.userId,
      },
      input.lines,
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.ledgerEntryPosted,
        entityType: 'ledger_entry',
        entityId: entry.id,
        after: {
          description: input.description,
          sourceType: input.sourceType,
          amount: input.lines
            .filter((line) => line.direction === 'debit')
            .reduce((sum, line) => sum + line.amount, 0),
        },
      },
      tx,
    );

    return entry;
  });
}

/**
 * Сторно: обратная проводка, оригинал остаётся. Удалять проводку нельзя —
 * журнал обязан показывать и ошибку, и её исправление (модуль 10).
 */
export async function reverseEntry(
  actor: UserActor,
  entryId: string,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  const { executor, today } = resolve(deps);

  assertCan(actor.context, 'accounting.write');

  const original = await findLedgerEntry(actor.context, entryId, executor);
  if (original === null) {
    throw new NotFoundError('Проводка не найдена');
  }

  if (original.reversedByEntryId !== null) {
    throw new ConflictError('accounting.errors.alreadyReversed');
  }

  const lines = await listLedgerLines(entryId, executor);

  return executor.transaction(async (tx) => {
    const { entry } = await createLedgerEntry(
      actor.context,
      {
        entryDate: today,
        description: `Сторно: ${original.description}`,
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        createdBy: actor.context.userId,
      },
      lines.map((line) => ({
        accountId: line.accountId,
        direction: line.direction === 'debit' ? ('credit' as const) : ('debit' as const),
        amount: line.amount,
      })),
      tx,
    );

    await markEntryReversed(original.id, entry.id, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.ledgerEntryReversed,
        entityType: 'ledger_entry',
        entityId: original.id,
        after: { reversedByEntryId: entry.id },
      },
      tx,
    );

    return entry;
  });
}

/** Счёт по коду; отсутствие системного счёта — поломка сида, а не данных. */
export async function requireAccountByCode(
  actor: UserActor,
  code: string,
  executor: Executor,
): Promise<Account> {
  const account = await findAccountByCode(actor.context, code, executor);

  if (account === null) {
    throw new NotFoundError(`Счёт ${code} не заведён: проверьте сид плана счетов`);
  }

  return account;
}

export interface ReconciliationRow {
  accountId: string;
  code: string;
  name: string;
  balance: number;
}

export interface DepositReconciliation {
  /** Остаток счёта «Депозитный фонд» как обязательство: положительное число. */
  fundBalance: number;
  /** Сумма остатков депозитов действующих проживаний. */
  depositsTotal: number;
  /** Ноль — сходится. Иначе величина расхождения (инвариант 4). */
  difference: number;
}

/**
 * Сверка депозитного фонда (§10.1, инвариант 4): остаток фонда против суммы
 * депозитов действующих проживаний. Расхождение — не ошибка отчёта, а сигнал:
 * где-то деньги прошли мимо проводки.
 */
export async function reconcileDepositFund(
  actor: UserActor,
  deps: LedgerDeps = {},
): Promise<DepositReconciliation> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'accounting.read');

  const fund = await requireAccountByCode(actor, ACCOUNT_CODES.depositFund, executor);
  const balances = await accountBalances(actor.context, {}, executor);
  const fundRow = balances.find((row) => row.accountId === fund.id);

  // Фонд — обязательство: кредит превышает дебет, поэтому знак разворачивается.
  const fundBalance = fundRow === undefined ? 0 : -fundRow.balance;

  const residencies = await listResidencies(actor.context, {}, executor);
  let depositsTotal = 0;

  for (const residency of residencies) {
    if (residency.status === 'archived') {
      continue;
    }

    const transactions = await listDepositTransactions(actor.context, residency.id, {}, executor);
    depositsTotal += depositBalance(transactions.map((transaction) => transaction.amount));
  }

  return { fundBalance, depositsTotal, difference: fundBalance - depositsTotal };
}

/** Оборотная ведомость: остатки по всем видимым счетам за период. */
export async function trialBalance(
  actor: UserActor,
  period: { from?: BusinessDate; to?: BusinessDate } = {},
  deps: LedgerDeps = {},
): Promise<ReconciliationRow[]> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'accounting.read');

  const [accounts, balances] = await Promise.all([
    listAccounts(actor.context, { includeArchived: true }, executor),
    accountBalances(actor.context, period, executor),
  ]);

  const byAccount = new Map(balances.map((row) => [row.accountId, row.balance]));

  return accounts.map((account) => ({
    accountId: account.id,
    code: account.code,
    name: account.name,
    balance: byAccount.get(account.id) ?? 0,
  }));
}
