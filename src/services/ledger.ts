import { getDb, type Executor } from '@/db/client';
import {
  accountBalances,
  createAccount,
  createLedgerEntry,
  findAccountByCode,
  findHouseAccount,
  findLedgerEntry,
  listAccounts,
  listLedgerLines,
  markEntryReversed,
  requireAccount,
} from '@/db/repositories/accounts';
import { listDepositTransactions } from '@/db/repositories/invoices';
import { listResidencies } from '@/db/repositories/residencies';
import { ACCOUNT_CODES, houseFundCode } from '@/db/schema';
import { depositBalance, type PaymentAllocation } from '@/domain/invoice';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { Account, House, LedgerEntry, Payment } from '@/db/schema';
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
 *
 * Прав на книгу проводок здесь не спрашивают: этот путь служит типовым
 * проводкам ниже, где право проверено по самой операции — оплате, ущербу,
 * возврату. Иначе админ дома, которому §10.1 книгу не открывает, не смог бы
 * принять депозит, и деньги пошли бы мимо учёта.
 */
async function postSystemEntry(
  actor: UserActor,
  input: PostEntryInput,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  const { executor, today } = resolve(deps);

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

/** Произвольная проводка руками суперадмина (модуль 10). */
export async function postEntry(
  actor: UserActor,
  input: PostEntryInput,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  assertCan(actor.context, 'accounting.write');

  return postSystemEntry(actor, input, deps);
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

/**
 * Фонд дома. Заводится вместе с домом: §10.1 требует по фонду на дом,
 * и без него ущерб со сгоранием депозита провести некуда. Повторный вызов
 * ничего не создаёт — сид и приложение заводят дома по-разному.
 */
export async function ensureHouseFund(
  actor: UserActor,
  house: Pick<House, 'id' | 'slug' | 'name'>,
  executor: Executor,
): Promise<Account> {
  const existing = await findHouseAccount(actor.context, house.id, 'house_fund', executor);

  if (existing !== null) {
    return existing;
  }

  return createAccount(
    actor.context,
    {
      houseId: house.id,
      code: houseFundCode(house.slug),
      name: `Фонд дома: ${house.name}`,
      type: 'house_fund',
      isSystem: true,
    },
    executor,
  );
}

async function requireHouseFund(
  actor: UserActor,
  houseId: string,
  executor: Executor,
): Promise<Account> {
  const fund = await findHouseAccount(actor.context, houseId, 'house_fund', executor);

  if (fund === null) {
    throw new NotFoundError('Фонд дома не заведён: проверьте план счетов');
  }

  return fund;
}

/** Куда физически легли деньги: касса или Kaspi (§10.1). */
function moneyCode(method: Payment['method']): string {
  return method === 'kaspi' ? ACCOUNT_CODES.kaspi : ACCOUNT_CODES.cash;
}

export interface DepositPaymentEntry {
  houseId: string;
  invoiceId: string;
  method: Payment['method'];
  /** Часть счёта, которая становится депозитом жильца. */
  deposit: number;
  /** Остальные строки счёта: доплата за дни до 1 числа — это проживание. */
  other: number;
  date?: BusinessDate | undefined;
}

/**
 * Оплата депозита (§10.1): Касса/Kaspi → Депозитный фонд. Прочие строки
 * депозитного счёта — плата за проживание, и она идёт в фонд дома:
 * иначе остаток депозитного фонда разошёлся бы с суммой депозитов
 * ровно на эту доплату (инвариант 4).
 */
export async function postDepositPayment(
  actor: UserActor,
  input: DepositPaymentEntry,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  const { executor } = resolve(deps);

  const money = await requireAccountByCode(actor, moneyCode(input.method), executor);
  const depositFund = await requireAccountByCode(actor, ACCOUNT_CODES.depositFund, executor);

  const lines: PostLine[] = [
    { accountId: money.id, direction: 'debit', amount: input.deposit + input.other },
    { accountId: depositFund.id, direction: 'credit', amount: input.deposit },
  ];

  if (input.other > 0) {
    const houseFund = await requireHouseFund(actor, input.houseId, executor);
    lines.push({ accountId: houseFund.id, direction: 'credit', amount: input.other });
  }

  return postSystemEntry(
    actor,
    {
      description: 'Оплата депозита',
      sourceType: 'deposit',
      sourceId: input.invoiceId,
      ...(input.date === undefined ? {} : { date: input.date }),
      lines,
    },
    deps,
  );
}

export interface DepositFundEntry {
  houseId: string;
  sourceId: string;
  amount: number;
  date?: BusinessDate | undefined;
}

/** Сгорание депозита (§10.1, §2.2): Депозитный фонд → Фонд дома. */
export async function postDepositBurn(
  actor: UserActor,
  input: DepositFundEntry,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  return postDepositFundToHouse(actor, input, 'Сгорание депозита', 'deposit', deps);
}

/** Списание ущерба (§10.1, §8): Депозитный фонд → Фонд дома. */
export async function postDamageCharge(
  actor: UserActor,
  input: DepositFundEntry,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  return postDepositFundToHouse(actor, input, 'Списание ущерба', 'damage', deps);
}

async function postDepositFundToHouse(
  actor: UserActor,
  input: DepositFundEntry,
  description: string,
  sourceType: string,
  deps: LedgerDeps,
): Promise<LedgerEntry> {
  const { executor } = resolve(deps);

  const depositFund = await requireAccountByCode(actor, ACCOUNT_CODES.depositFund, executor);
  const houseFund = await requireHouseFund(actor, input.houseId, executor);

  return postSystemEntry(
    actor,
    {
      description,
      sourceType,
      sourceId: input.sourceId,
      ...(input.date === undefined ? {} : { date: input.date }),
      lines: [
        { accountId: depositFund.id, direction: 'debit', amount: input.amount },
        { accountId: houseFund.id, direction: 'credit', amount: input.amount },
      ],
    },
    deps,
  );
}

/**
 * Излишек округления коммуналки — в фонд дома (§4.2): Коммунальный фонд →
 * Фонд дома. Проводка идёт при закрытии периода: жильцы вносят сумму долей,
 * а поставщику причитается ровно итог периода — разница дому.
 */
export async function postUtilitySurplus(
  actor: UserActor,
  input: DepositFundEntry,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  const { executor } = resolve(deps);

  const utilityFund = await requireAccountByCode(actor, ACCOUNT_CODES.utilityFund, executor);
  const houseFund = await requireHouseFund(actor, input.houseId, executor);

  return postSystemEntry(
    actor,
    {
      description: 'Излишек округления коммуналки',
      sourceType: 'utilities',
      sourceId: input.sourceId,
      ...(input.date === undefined ? {} : { date: input.date }),
      lines: [
        { accountId: utilityFund.id, direction: 'debit', amount: input.amount },
        { accountId: houseFund.id, direction: 'credit', amount: input.amount },
      ],
    },
    deps,
  );
}

export interface InvoicePaymentEntry {
  houseId: string;
  invoiceId: string;
  method: Payment['method'];
  /** Разнесение платежа по фондам (§10.1); сумма долей — сам платёж. */
  allocation: PaymentAllocation;
  date?: BusinessDate | undefined;
}

/**
 * Платёж по счёту (§10.1). Дебет — касса или Kaspi на всю сумму, кредит
 * расходится по фондам: коммуналка поставщику, погашение перерасхода
 * обратно в депозитный фонд, остальное — фонд дома. Одной проводкой,
 * а не тремя: деньги пришли одним платежом.
 */
export async function postInvoicePayment(
  actor: UserActor,
  input: InvoicePaymentEntry,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  const { executor } = resolve(deps);

  const total = input.allocation.utilities + input.allocation.deposit + input.allocation.house;
  const money = await requireAccountByCode(actor, moneyCode(input.method), executor);
  const lines: PostLine[] = [{ accountId: money.id, direction: 'debit', amount: total }];

  if (input.allocation.utilities > 0) {
    const utilityFund = await requireAccountByCode(actor, ACCOUNT_CODES.utilityFund, executor);
    lines.push({
      accountId: utilityFund.id,
      direction: 'credit',
      amount: input.allocation.utilities,
    });
  }

  if (input.allocation.deposit > 0) {
    const depositFund = await requireAccountByCode(actor, ACCOUNT_CODES.depositFund, executor);
    lines.push({
      accountId: depositFund.id,
      direction: 'credit',
      amount: input.allocation.deposit,
    });
  }

  if (input.allocation.house > 0) {
    const houseFund = await requireHouseFund(actor, input.houseId, executor);
    lines.push({ accountId: houseFund.id, direction: 'credit', amount: input.allocation.house });
  }

  return postSystemEntry(
    actor,
    {
      description: 'Оплата счёта',
      sourceType: 'invoice',
      sourceId: input.invoiceId,
      ...(input.date === undefined ? {} : { date: input.date }),
      lines,
    },
    deps,
  );
}

export interface DepositRefundEntry {
  invoiceId: string;
  amount: number;
  method: Payment['method'];
  date?: BusinessDate | undefined;
}

/** Возврат депозита (§10.1, §2.2): Депозитный фонд → Касса/Kaspi. */
export async function postDepositRefund(
  actor: UserActor,
  input: DepositRefundEntry,
  deps: LedgerDeps = {},
): Promise<LedgerEntry> {
  const { executor } = resolve(deps);

  const depositFund = await requireAccountByCode(actor, ACCOUNT_CODES.depositFund, executor);
  const money = await requireAccountByCode(actor, moneyCode(input.method), executor);

  return postSystemEntry(
    actor,
    {
      description: 'Возврат депозита',
      sourceType: 'deposit',
      sourceId: input.invoiceId,
      ...(input.date === undefined ? {} : { date: input.date }),
      lines: [
        { accountId: depositFund.id, direction: 'debit', amount: input.amount },
        { accountId: money.id, direction: 'credit', amount: input.amount },
      ],
    },
    deps,
  );
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
