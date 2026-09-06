import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

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

export async function listInvoices(
  context: AccessContext,
  filter: { residencyId?: string; type?: Invoice['type'] } = {},
  executor: Executor = getDb(),
): Promise<Invoice[]> {
  const conditions = [invoiceScope(context, executor)];

  if (filter.residencyId !== undefined) {
    conditions.push(eq(invoices.residencyId, filter.residencyId));
  }
  if (filter.type !== undefined) {
    conditions.push(eq(invoices.type, filter.type));
  }

  return executor
    .select()
    .from(invoices)
    .where(and(...conditions))
    .orderBy(desc(invoices.createdAt));
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
