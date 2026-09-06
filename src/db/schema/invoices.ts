import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { houses } from './houses';
import { organizations } from './organizations';
import { residencies } from './residencies';
import { users } from './users';

/**
 * Счета, строки счетов, платежи и движение депозита
 * (docs/02-DATA-MODEL.md, docs/03-BUSINESS-RULES.md §3).
 *
 * В фазе 2 из всей этой машинерии работает только депозит: счёт типа
 * `deposit` и платежи по нему. Месячная генерация, коммуналка, штрафы
 * и скидки — фаза 3. Форма таблиц заведена сразу целиком: менять её
 * дважды дороже, чем завести один раз по модели данных.
 *
 * Деньги — целые тенге в `bigint` (D9).
 */
export const invoiceTypeEnum = pgEnum('invoice_type', [
  'deposit',
  'monthly',
  'extra',
  'deposit_refund',
]);

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'pending',
  'issued',
  'partially_paid',
  'paid',
  'cancelled',
  'returned',
  'burned',
]);

export const invoiceLineKindEnum = pgEnum('invoice_line_kind', [
  'rent',
  'utilities',
  'fine',
  'damage_carryover',
  'extra',
  'deposit',
  'discount',
  'proration',
]);

export const paymentMethodEnum = pgEnum('payment_method', ['kaspi', 'cash']);

export const depositTransactionTypeEnum = pgEnum('deposit_transaction_type', [
  'charge',
  'damage_share',
  'damage_reversal',
  'refund',
  'burn',
  'adjustment',
]);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    residencyId: uuid('residency_id')
      .notNull()
      .references(() => residencies.id),
    type: invoiceTypeEnum('type').notNull(),
    /** Первое число месяца, к которому относится счёт. У депозита — пусто. */
    periodMonth: date('period_month'),
    status: invoiceStatusEnum('status').notNull().default('issued'),
    total: bigint('total', { mode: 'number' }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueDate: date('due_date'),
    remoteSentAt: timestamp('remote_sent_at', { withTimezone: true }),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('invoices_residency_idx').on(table.residencyId),
    index('invoices_house_status_idx').on(table.houseId, table.status),
  ],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    kind: invoiceLineKindEnum('kind').notNull(),
    title: text('title').notNull(),
    /** Скидка — отрицательная строка (§5.4). */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('invoice_lines_invoice_idx').on(table.invoiceId)],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    method: paymentMethodEnum('method').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').references(() => users.id),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('payments_invoice_idx').on(table.invoiceId)],
);

export const depositTransactions = pgTable(
  'deposit_transactions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    residencyId: uuid('residency_id')
      .notNull()
      .references(() => residencies.id),
    type: depositTransactionTypeEnum('type').notNull(),
    /** Со знаком: пополнение положительное, списание отрицательное. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    /** Откуда движение: счёт, ущерб, ручная правка. */
    refType: text('ref_type'),
    refId: uuid('ref_id'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('deposit_transactions_residency_idx').on(table.residencyId, table.createdAt)],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type NewInvoiceLine = typeof invoiceLines.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type DepositTransaction = typeof depositTransactions.$inferSelect;
export type NewDepositTransaction = typeof depositTransactions.$inferInsert;
