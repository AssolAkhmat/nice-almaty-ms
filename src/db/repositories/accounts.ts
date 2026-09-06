import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  accounts,
  ledgerEntries,
  ledgerLines,
  type Account,
  type LedgerEntry,
  type LedgerLine,
  type NewAccount,
  type NewLedgerEntry,
  type NewLedgerLine,
} from '../schema';

/**
 * План счетов и книга проводок (docs/03-BUSINESS-RULES.md §10.1).
 *
 * Счета сети видны суперадмину целиком; админ видит счета своего дома
 * и общие счета сети — по ним проходят его же деньги, и без них
 * оборотная ведомость дома читалась бы наполовину.
 */
function accountScope(context: AccessContext) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return eq(accounts.orgId, context.orgId);
  }

  if (visible.length === 0) {
    return sql`false`;
  }

  return and(
    eq(accounts.orgId, context.orgId),
    or(isNull(accounts.houseId), inArray(accounts.houseId, [...visible])),
  );
}

export async function listAccounts(
  context: AccessContext,
  filter: { houseId?: string; includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<Account[]> {
  const conditions = [accountScope(context)];

  if (filter.houseId !== undefined) {
    assertHouseVisible(context, filter.houseId);
    conditions.push(eq(accounts.houseId, filter.houseId));
  }
  if (filter.includeArchived !== true) {
    conditions.push(isNull(accounts.archivedAt));
  }

  return executor
    .select()
    .from(accounts)
    .where(and(...conditions))
    .orderBy(asc(accounts.code));
}

export async function findAccountByCode(
  context: AccessContext,
  code: string,
  executor: Executor = getDb(),
): Promise<Account | null> {
  const [account] = await executor
    .select()
    .from(accounts)
    .where(and(accountScope(context), eq(accounts.code, code)))
    .limit(1);

  return account ?? null;
}

export async function requireAccount(
  context: AccessContext,
  accountId: string,
  executor: Executor = getDb(),
): Promise<Account> {
  const [account] = await executor
    .select()
    .from(accounts)
    .where(and(accountScope(context), eq(accounts.id, accountId)))
    .limit(1);

  if (account === undefined) {
    throw new NotFoundError('Счёт не найден');
  }

  return account;
}

export async function createAccount(
  context: AccessContext,
  input: Omit<NewAccount, 'orgId'>,
  executor: Executor = getDb(),
): Promise<Account> {
  if (input.houseId != null) {
    assertHouseVisible(context, input.houseId);
  }

  const [account] = await executor
    .insert(accounts)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (account === undefined) {
    throw new Error('Счёт не создан');
  }

  return account;
}

export async function updateAccount(
  context: AccessContext,
  accountId: string,
  patch: Partial<Omit<NewAccount, 'id' | 'orgId'>>,
  executor: Executor = getDb(),
): Promise<Account | null> {
  const [account] = await executor
    .update(accounts)
    .set({ ...patch, updatedAt: now() })
    .where(and(accountScope(context), eq(accounts.id, accountId)))
    .returning();

  return account ?? null;
}

/**
 * Проводка целиком: запись и её строки пишутся одной операцией.
 * Равенство дебета и кредита проверяет сервис — это правило учёта,
 * а не форма хранения (инвариант 3).
 */
export async function createLedgerEntry(
  context: AccessContext,
  input: Omit<NewLedgerEntry, 'orgId'>,
  lines: readonly Omit<NewLedgerLine, 'entryId'>[],
  executor: Executor = getDb(),
): Promise<{ entry: LedgerEntry; lines: LedgerLine[] }> {
  const [entry] = await executor
    .insert(ledgerEntries)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (entry === undefined) {
    throw new Error('Проводка не создана');
  }

  const inserted = await executor
    .insert(ledgerLines)
    .values(lines.map((line) => ({ ...line, entryId: entry.id })))
    .returning();

  return { entry, lines: inserted };
}

export async function listLedgerEntries(
  context: AccessContext,
  filter: { from?: BusinessDate; to?: BusinessDate; sourceType?: string; accountId?: string } = {},
  executor: Executor = getDb(),
): Promise<LedgerEntry[]> {
  const conditions = [eq(ledgerEntries.orgId, context.orgId)];

  if (filter.from !== undefined) {
    conditions.push(gte(ledgerEntries.entryDate, filter.from));
  }
  if (filter.to !== undefined) {
    conditions.push(lte(ledgerEntries.entryDate, filter.to));
  }
  if (filter.sourceType !== undefined) {
    conditions.push(eq(ledgerEntries.sourceType, filter.sourceType));
  }
  if (filter.accountId !== undefined) {
    conditions.push(
      inArray(
        ledgerEntries.id,
        executor
          .select({ id: ledgerLines.entryId })
          .from(ledgerLines)
          .where(eq(ledgerLines.accountId, filter.accountId)),
      ),
    );
  }

  return executor
    .select()
    .from(ledgerEntries)
    .where(and(...conditions))
    .orderBy(desc(ledgerEntries.entryDate), desc(ledgerEntries.createdAt));
}

export async function findLedgerEntry(
  context: AccessContext,
  entryId: string,
  executor: Executor = getDb(),
): Promise<LedgerEntry | null> {
  const [entry] = await executor
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.orgId, context.orgId), eq(ledgerEntries.id, entryId)))
    .limit(1);

  return entry ?? null;
}

export async function listLedgerLines(
  entryId: string,
  executor: Executor = getDb(),
): Promise<LedgerLine[]> {
  return executor
    .select()
    .from(ledgerLines)
    .where(eq(ledgerLines.entryId, entryId))
    .orderBy(asc(ledgerLines.createdAt));
}

export async function markEntryReversed(
  entryId: string,
  reversalId: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(ledgerEntries)
    .set({ reversedByEntryId: reversalId })
    .where(eq(ledgerEntries.id, entryId));
}

export interface AccountBalance {
  accountId: string;
  /** Дебет минус кредит: для фондов это обязательство со знаком минус. */
  balance: number;
  debit: number;
  credit: number;
}

/**
 * Остатки по счетам за период. Считает база, а не приложение: строк проводок
 * со временем становится больше, чем разумно тянуть в память.
 */
export async function accountBalances(
  context: AccessContext,
  filter: { from?: BusinessDate; to?: BusinessDate } = {},
  executor: Executor = getDb(),
): Promise<AccountBalance[]> {
  const conditions = [eq(ledgerEntries.orgId, context.orgId)];

  if (filter.from !== undefined) {
    conditions.push(gte(ledgerEntries.entryDate, filter.from));
  }
  if (filter.to !== undefined) {
    conditions.push(lte(ledgerEntries.entryDate, filter.to));
  }

  const rows = await executor
    .select({
      accountId: ledgerLines.accountId,
      debit: sql<number>`coalesce(sum(case when ${ledgerLines.direction} = 'debit' then ${ledgerLines.amount} else 0 end), 0)::int`,
      credit: sql<number>`coalesce(sum(case when ${ledgerLines.direction} = 'credit' then ${ledgerLines.amount} else 0 end), 0)::int`,
    })
    .from(ledgerLines)
    .innerJoin(ledgerEntries, eq(ledgerEntries.id, ledgerLines.entryId))
    .where(and(...conditions))
    .groupBy(ledgerLines.accountId);

  return rows.map((row) => ({
    accountId: row.accountId,
    debit: row.debit,
    credit: row.credit,
    balance: row.debit - row.credit,
  }));
}
