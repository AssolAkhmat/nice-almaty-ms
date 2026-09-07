import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { houses } from './houses';
import { invoices } from './invoices';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Рейтинг, штрафы и скидки (docs/02-DATA-MODEL.md, docs/03-BUSINESS-RULES.md §5).
 *
 * Значение рейтинга нигде не хранится: оно складывается из событий года,
 * начинающегося 1 июля. Снимок разошёлся бы с историей при первой же правке
 * события задним числом, а §5.6 обещает админу «полную историю» — значит
 * она и есть источник истины.
 */
export const ratingRuleKindEnum = pgEnum('rating_rule_kind', [
  'score_delta',
  'admin_action',
  'threshold_down',
  'threshold_up',
]);

/**
 * Правило рейтинга: дельта, действие админа или порог.
 *
 * Уровень сети — `house_id is null`; строка с домом переопределяет сетевую
 * по тому же `code` (§5.5).
 */
export const ratingRules = pgTable(
  'rating_rules',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** Пусто — правило сети; заполнено — переопределение дома. */
    houseId: uuid('house_id').references(() => houses.id),
    kind: ratingRuleKindEnum('kind').notNull(),
    /** Код правила: оценка `score:10`, действие `help`, порог `down:40`. */
    code: text('code').notNull(),
    /** `{score, delta}`, `{delta}`, `{threshold, actions, fine_amount}`. */
    config: jsonb('config').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /*
     * Одно правило на код в пределах уровня: сеть и дом не спорят сами с собой.
     * Индексов два, потому что в PostgreSQL NULL не равен NULL: обычная
     * уникальность по трём колонкам пропустила бы сколько угодно правил сети
     * с одним и тем же кодом.
     */
    uniqueIndex('rating_rules_network_code_unique')
      .on(table.orgId, table.code)
      .where(sql`${table.houseId} is null`),
    uniqueIndex('rating_rules_house_code_unique')
      .on(table.orgId, table.houseId, table.code)
      .where(sql`${table.houseId} is not null`),
    index('rating_rules_org_idx').on(table.orgId, table.kind),
  ],
);

/**
 * Событие рейтинга: оценка уборки, действие админа или сброс года.
 *
 * `period_start` — 1 июля года рейтинга: по нему события и складываются
 * в текущее значение, а прошлые годы остаются историей (§5.1).
 */
export const ratingEvents = pgTable(
  'rating_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Код события: `score:9`, `violation`, `year_reset`. */
    type: text('type').notNull(),
    delta: integer('delta').notNull(),
    /** На что ссылается событие: `rotation_assignment`, `admin_action`. */
    refType: text('ref_type'),
    refId: uuid('ref_id'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    periodStart: date('period_start').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rating_events_user_idx').on(table.userId, table.periodStart, table.effectiveAt),
    /*
     * Одно событие на одну оценку: повторный расчёт того же назначения
     * не должен начислять дельту второй раз. Действия админа под ограничение
     * не попадают — у них своей ссылки нет.
     */
    uniqueIndex('rating_events_ref_unique')
      .on(table.userId, table.refType, table.refId)
      .where(sql`${table.refId} is not null`),
  ],
);

/** Взведён ли порог у жильца (§5.3): состояние живёт между событиями. */
export const ratingThresholdStates = pgTable(
  'rating_threshold_states',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => ratingRules.id),
    armed: boolean('armed').notNull().default(true),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('rating_threshold_states_unique').on(table.userId, table.ruleId)],
);

/** Штраф отменяется до применения и сторнируется после (§5.5). */
export const fineStatusEnum = pgEnum('fine_status', ['pending', 'applied', 'cancelled']);

export const fines = pgTable(
  'fines',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    /** Целые тенге (§0). */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    /** Правило порога, если штраф начислен им, а не рукой админа. */
    ruleId: uuid('rule_id').references(() => ratingRules.id),
    reason: text('reason').notNull(),
    status: fineStatusEnum('status').notNull().default('pending'),
    /** Счёт, в который штраф попал строкой. */
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelledReason: text('cancelled_reason'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('fines_user_idx').on(table.userId, table.status)],
);

/** Скидка предлагается системой и подтверждается суперадмином (§5.4). */
export const discountStatusEnum = pgEnum('discount_status', ['proposed', 'approved', 'revoked']);

export const discounts = pgTable(
  'discounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => ratingRules.id),
    status: discountStatusEnum('status').notNull().default('proposed'),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('discounts_user_idx').on(table.userId, table.status),
    // Одно предложение на порог у жильца: второе появляется после отзыва.
    uniqueIndex('discounts_open_unique')
      .on(table.userId, table.ruleId)
      .where(sql`${table.status} <> 'revoked'`),
  ],
);

export type RatingRule = typeof ratingRules.$inferSelect;
export type NewRatingRule = typeof ratingRules.$inferInsert;
export type RatingEvent = typeof ratingEvents.$inferSelect;
export type NewRatingEvent = typeof ratingEvents.$inferInsert;
export type RatingThresholdState = typeof ratingThresholdStates.$inferSelect;
export type NewRatingThresholdState = typeof ratingThresholdStates.$inferInsert;
export type Fine = typeof fines.$inferSelect;
export type NewFine = typeof fines.$inferInsert;
export type Discount = typeof discounts.$inferSelect;
export type NewDiscount = typeof discounts.$inferInsert;
