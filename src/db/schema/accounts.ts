import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { houses } from './houses';
import { organizations } from './organizations';
import { users } from './users';

/**
 * План счетов и двойная запись (docs/02-DATA-MODEL.md,
 * docs/03-BUSINESS-RULES.md §10.1).
 *
 * Каждая операция — проводка с равными дебетом и кредитом (инвариант 3).
 * Сумма хранится положительной, направление задаёт строка: так проводка
 * читается тем же способом, каким её пишет бухгалтер.
 */
export const accountTypeEnum = pgEnum('account_type', [
  'deposit_fund',
  'house_fund',
  'utility_fund',
  'common_fund',
  'cash',
  'kaspi',
  'external',
]);

/**
 * Коды системных счетов. Живут рядом с типами, а не в сервисе: их называют
 * и сид, и заведение дома — а `src/db` не вправе смотреть в `src/services`.
 * Фонд свой у каждого дома, отсюда суффикс со слагом.
 */
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

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** Пусто — счёт всей сети; заполнено — счёт конкретного дома. */
    houseId: uuid('house_id').references(() => houses.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    /** Системный счёт не удаляется: на него ссылаются типовые проводки. */
    isSystem: boolean('is_system').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('accounts_org_code_unique').on(table.orgId, table.code),
    index('accounts_house_idx').on(table.houseId),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** Дата операции по календарю Алматы, без времени. */
    entryDate: date('entry_date').notNull(),
    description: text('description').notNull(),
    /** Откуда проводка: `invoice`, `deposit`, `damage`, `manual`, `expense`. */
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    /** Сторно не удаляет оригинал, а ссылается на обратную проводку. */
    reversedByEntryId: uuid('reversed_by_entry_id'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ledger_entries_org_date_idx').on(table.orgId, table.entryDate),
    index('ledger_entries_source_idx').on(table.sourceType, table.sourceId),
  ],
);

export const ledgerDirectionEnum = pgEnum('ledger_direction', ['debit', 'credit']);

export const ledgerLines = pgTable(
  'ledger_lines',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => ledgerEntries.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    direction: ledgerDirectionEnum('direction').notNull(),
    /** Целые тенге, всегда положительные: знак несёт направление. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ledger_lines_entry_idx').on(table.entryId),
    index('ledger_lines_account_idx').on(table.accountId),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type LedgerLine = typeof ledgerLines.$inferSelect;
export type NewLedgerLine = typeof ledgerLines.$inferInsert;
