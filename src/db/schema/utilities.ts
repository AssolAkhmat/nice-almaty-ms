import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { files } from './files';
import { houses } from './houses';
import { invoiceLines } from './invoices';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Коммунальные услуги (docs/02-DATA-MODEL.md, docs/03-BUSINESS-RULES.md §4).
 *
 * Распределение сохраняется снимком: закрытый период больше не пересчитывается,
 * иначе история счетов менялась бы задним числом вслед за правкой строки.
 */
export const utilityPeriodStatusEnum = pgEnum('utility_period_status', ['draft', 'closed']);

export const utilityPeriods = pgTable(
  'utility_periods',
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
    /** Первое число месяца, за который собирается коммуналка. */
    month: date('month').notNull(),
    status: utilityPeriodStatusEnum('status').notNull().default('draft'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('utility_periods_house_month_unique').on(table.houseId, table.month)],
);

export const utilityLines = pgTable(
  'utility_lines',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    periodId: uuid('period_id')
      .notNull()
      .references(() => utilityPeriods.id),
    title: text('title').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    receiptFileId: uuid('receipt_file_id').references(() => files.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('utility_lines_period_idx').on(table.periodId)],
);

/** Снимок расчёта: дни и доля каждого жильца на момент закрытия периода. */
export const utilityAllocations = pgTable(
  'utility_allocations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    periodId: uuid('period_id')
      .notNull()
      .references(() => utilityPeriods.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    days: integer('days').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    /** Строка счёта, в которую доля попала. Пусто — счёт ещё не выставлен. */
    invoiceLineId: uuid('invoice_line_id').references(() => invoiceLines.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('utility_allocations_period_user_unique').on(table.periodId, table.userId),
  ],
);

export type UtilityPeriod = typeof utilityPeriods.$inferSelect;
export type NewUtilityPeriod = typeof utilityPeriods.$inferInsert;
export type UtilityLine = typeof utilityLines.$inferSelect;
export type NewUtilityLine = typeof utilityLines.$inferInsert;
export type UtilityAllocation = typeof utilityAllocations.$inferSelect;
export type NewUtilityAllocation = typeof utilityAllocations.$inferInsert;
