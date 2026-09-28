import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
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
    /**
     * Доля дома в человеко-днях (P2-7, указание владельца 27 сентября 2026).
     * Общие помещения греются независимо от заселённости, пустые места тоже
     * потребляют. Число вводит администратор — система его не вычисляет.
     */
    houseDays: integer('house_days').notNull().default(0),
    houseDaysComment: text('house_days_comment'),
    /** Сумма доли дома на момент закрытия: снимок наравне с долями жильцов. */
    houseAmount: bigint('house_amount', { mode: 'number' }).notNull().default(0),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('utility_periods_house_month_unique').on(table.houseId, table.month),
    check(
      'utility_periods_house_days_non_negative',
      sql`${table.houseDays} >= 0 and ${table.houseAmount} >= 0`,
    ),
    /*
     * Ненулевая доля дома без объяснения — это молча уменьшенные счета
     * жильцов. Запрет стоит в базе: сумма, за которую некому ответить,
     * хуже отсутствующей.
     */
    check(
      'utility_periods_house_days_comment',
      sql`${table.houseDays} = 0 or btrim(coalesce(${table.houseDaysComment}, '')) <> ''`,
    ),
  ],
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

/**
 * Ручная корректировка человеко-дней жильца (находка P2-6, 27 сентября 2026).
 *
 * Формула §4.2 считает сутки по датам заселения и одобренным отъездам, и она
 * права ровно настолько, насколько полны эти данные. В январе жильцы
 * разъезжаются на каникулы, не оформляя отсутствие, а отопление горит:
 * начисление по календарю получается справедливым только на бумаге.
 * Поэтому админ вправе поставить своё число суток — с обязательным
 * объяснением и с сохранением расчётного значения рядом.
 *
 * Расчётное значение хранится снимком (`system_days`), а не пересчитывается
 * при показе: даты проживания правятся и после корректировки, и тогда
 * «что считала система» изменилось бы задним числом вместе с ними.
 */
export const utilityDayAdjustments = pgTable(
  'utility_day_adjustments',
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
    /** Что посчитала система на момент правки. */
    systemDays: integer('system_days').notNull(),
    /** Что поставил администратор. Это значение и идёт в расчёт. */
    days: integer('days').notNull(),
    comment: text('comment').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('utility_day_adjustments_user_unique').on(table.periodId, table.userId),
    /*
     * Обязательность комментария стоит в базе, а не только в сервисе:
     * корректировка без объяснения — это неотличимая от ошибки правка денег,
     * а вставок в таблицу со временем становится больше одной.
     */
    check('utility_day_adjustments_comment_present', sql`btrim(${table.comment}) <> ''`),
    check(
      'utility_day_adjustments_days_non_negative',
      sql`${table.days} >= 0 and ${table.systemDays} >= 0`,
    ),
  ],
);

export type UtilityPeriod = typeof utilityPeriods.$inferSelect;
export type NewUtilityPeriod = typeof utilityPeriods.$inferInsert;
export type UtilityLine = typeof utilityLines.$inferSelect;
export type NewUtilityLine = typeof utilityLines.$inferInsert;
export type UtilityAllocation = typeof utilityAllocations.$inferSelect;
export type NewUtilityAllocation = typeof utilityAllocations.$inferInsert;
export type UtilityDayAdjustment = typeof utilityDayAdjustments.$inferSelect;
export type NewUtilityDayAdjustment = typeof utilityDayAdjustments.$inferInsert;
