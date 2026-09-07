import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { assertHouseVisible } from '../access';
import { getDb, type Executor } from '../client';
import {
  depositTransactions,
  invoiceLines,
  invoices,
  payments,
  residencies,
  type DepositTransaction,
  type Invoice,
  type InvoiceLine,
  type NewDepositTransaction,
  type NewInvoice,
  type NewInvoiceLine,
  type NewPayment,
  type Payment,
} from '../schema';
import { residencyVisibility } from './residencies';

import type { AccessContext } from '../access';

/**
 * Счета, платежи и движение депозита.
 *
 * Видимость идёт через проживание — тем же правилом, что у файлов, документов
 * и договора (P2-5): жилец видит своё, админ — свой дом, суперадмин — сеть.
 */
function visibleResidencies(context: AccessContext, executor: Executor) {
  return executor
    .select({ id: residencies.id })
    .from(residencies)
    .where(residencyVisibility(context));
}

function invoiceScope(context: AccessContext, executor: Executor) {
  return and(
    eq(invoices.orgId, context.orgId),
    inArray(invoices.residencyId, visibleResidencies(context, executor)),
  );
}

function depositScope(context: AccessContext, executor: Executor) {
  return and(
    eq(depositTransactions.orgId, context.orgId),
    inArray(depositTransactions.residencyId, visibleResidencies(context, executor)),
  );
}

export async function createInvoice(
  context: AccessContext,
  input: Omit<NewInvoice, 'orgId'>,
  executor: Executor = getDb(),
): Promise<Invoice> {
  const [invoice] = await executor
    .insert(invoices)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (invoice === undefined) {
    throw new Error('Счёт не создан');
  }

  return invoice;
}

export async function addInvoiceLines(
  lines: readonly NewInvoiceLine[],
  executor: Executor = getDb(),
): Promise<InvoiceLine[]> {
  if (lines.length === 0) {
    return [];
  }

  return executor
    .insert(invoiceLines)
    .values([...lines])
    .returning();
}

export interface InvoiceFilter {
  residencyId?: string;
  type?: Invoice['type'];
  houseId?: string;
  /** Первое число месяца, к которому относится счёт. */
  periodMonth?: BusinessDate;
  status?: Invoice['status'];
}

export async function listInvoices(
  context: AccessContext,
  filter: InvoiceFilter = {},
  executor: Executor = getDb(),
): Promise<Invoice[]> {
  const conditions = [invoiceScope(context, executor)];

  if (filter.residencyId !== undefined) {
    conditions.push(eq(invoices.residencyId, filter.residencyId));
  }
  if (filter.type !== undefined) {
    conditions.push(eq(invoices.type, filter.type));
  }
  if (filter.houseId !== undefined) {
    assertHouseVisible(context, filter.houseId);
    conditions.push(eq(invoices.houseId, filter.houseId));
  }
  if (filter.periodMonth !== undefined) {
    conditions.push(eq(invoices.periodMonth, filter.periodMonth));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(invoices.status, filter.status));
  }

  return executor
    .select()
    .from(invoices)
    .where(and(...conditions))
    .orderBy(desc(invoices.periodMonth), desc(invoices.createdAt));
}

export async function findInvoice(
  context: AccessContext,
  invoiceId: string,
  executor: Executor = getDb(),
): Promise<Invoice | null> {
  const [invoice] = await executor
    .select()
    .from(invoices)
    .where(and(invoiceScope(context, executor), eq(invoices.id, invoiceId)))
    .limit(1);

  return invoice ?? null;
}

export async function requireInvoice(
  context: AccessContext,
  invoiceId: string,
  executor: Executor = getDb(),
): Promise<Invoice> {
  const invoice = await findInvoice(context, invoiceId, executor);
  if (invoice === null) {
    throw new NotFoundError('Счёт не найден');
  }

  return invoice;
}

export async function updateInvoice(
  context: AccessContext,
  invoiceId: string,
  patch: Partial<Omit<NewInvoice, 'id' | 'orgId' | 'residencyId'>>,
  executor: Executor = getDb(),
): Promise<Invoice | null> {
  const [invoice] = await executor
    .update(invoices)
    .set({ ...patch, updatedAt: now() })
    .where(and(invoiceScope(context, executor), eq(invoices.id, invoiceId)))
    .returning();

  return invoice ?? null;
}

export async function listInvoiceLines(
  invoiceId: string,
  executor: Executor = getDb(),
): Promise<InvoiceLine[]> {
  return executor
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.createdAt));
}

/**
 * Строки счёта переписываются целиком: правка идёт списком, а не по одной,
 * и сумма счёта пересобирается из того же списка (инвариант 5). Дописывать
 * поверх старых значило бы держать два источника итога.
 */
export async function replaceInvoiceLines(
  invoiceId: string,
  lines: readonly Omit<NewInvoiceLine, 'invoiceId'>[],
  executor: Executor = getDb(),
): Promise<InvoiceLine[]> {
  await executor.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));

  return addInvoiceLines(
    lines.map((line) => ({ ...line, invoiceId })),
    executor,
  );
}

/** Внесено по каждому счёту — одной выборкой: таблица дома считает сводку. */
export async function paidTotals(
  invoiceIds: readonly string[],
  executor: Executor = getDb(),
): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      invoiceId: payments.invoiceId,
      paid: sql<number>`coalesce(sum(${payments.amount}), 0)::int`,
    })
    .from(payments)
    .where(inArray(payments.invoiceId, [...invoiceIds]))
    .groupBy(payments.invoiceId);

  return new Map(rows.map((row) => [row.invoiceId, row.paid]));
}

export async function listPayments(
  invoiceId: string,
  executor: Executor = getDb(),
): Promise<Payment[]> {
  return executor
    .select()
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId))
    .orderBy(asc(payments.paidAt));
}

export async function createPayment(
  input: NewPayment,
  executor: Executor = getDb(),
): Promise<Payment> {
  const [payment] = await executor.insert(payments).values(input).returning();

  if (payment === undefined) {
    throw new Error('Платёж не создан');
  }

  return payment;
}

export async function createDepositTransaction(
  context: AccessContext,
  input: Omit<NewDepositTransaction, 'orgId'>,
  executor: Executor = getDb(),
): Promise<DepositTransaction> {
  const [transaction] = await executor
    .insert(depositTransactions)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (transaction === undefined) {
    throw new Error('Движение депозита не создано');
  }

  return transaction;
}

/**
 * Движение депозита. Полуоткрытый интервал `[from, to)`: жилец видит все
 * списания за год (§8), и границы года не должны пересекаться.
 */
export async function listDepositTransactions(
  context: AccessContext,
  residencyId: string,
  range: { from?: Date; to?: Date } = {},
  executor: Executor = getDb(),
): Promise<DepositTransaction[]> {
  const conditions = [
    depositScope(context, executor),
    eq(depositTransactions.residencyId, residencyId),
  ];

  if (range.from !== undefined) {
    conditions.push(gte(depositTransactions.createdAt, range.from));
  }
  if (range.to !== undefined) {
    conditions.push(lt(depositTransactions.createdAt, range.to));
  }

  return executor
    .select()
    .from(depositTransactions)
    .where(and(...conditions))
    .orderBy(asc(depositTransactions.createdAt));
}
