import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { houses } from './houses';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Инвентарь дома (docs/02-DATA-MODEL.md, «Инвентарь»;
 * docs/04-MODULES/10-accounting-inventory.md).
 *
 * Количество — `numeric(12,2)`, а не целое: у инвентаря своя единица
 * измерения, и полтора литра краски или два с половиной метра ткани
 * существуют. Правило целых тенге к нему не применяется — оно про деньги
 * (§0). Стоимость единицы, наоборот, деньги: `bigint` в целых тенге.
 */
export const inventoryStatusEnum = pgEnum('inventory_status', ['in_use', 'written_off']);

export const inventoryItems = pgTable(
  'inventory_items',
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
    name: text('name').notNull(),
    qty: numeric('qty', { precision: 12, scale: 2 }).notNull().default('0'),
    /** Штуки, литры, метры: единицу задаёт тот, кто заводит позицию. */
    unit: text('unit').notNull(),
    /** Стоимость единицы в целых тенге (§0). */
    unitCost: bigint('unit_cost', { mode: 'number' }).notNull().default(0),
    responsibleUserId: uuid('responsible_user_id').references(() => users.id),
    status: inventoryStatusEnum('status').notNull().default('in_use'),
    acquiredAt: date('acquired_at'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('inventory_items_house_idx').on(table.houseId, table.status)],
);

export const inventoryMovementTypeEnum = pgEnum('inventory_movement_type', [
  'in',
  'out',
  'write_off',
  'transfer',
  'audit_adjust',
]);

/**
 * Движение по позиции: приход, расход, списание, перемещение и
 * корректировка по итогам инвентаризации.
 *
 * История не переписывается: количество позиции — следствие движений,
 * и исправление ошибки — это ещё одно движение, а не правка прежнего.
 */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    type: inventoryMovementTypeEnum('type').notNull(),
    qty: numeric('qty', { precision: 12, scale: 2 }).notNull(),
    date: date('date').notNull(),
    /** Дома перемещения: у прихода и списания заполнен только один. */
    fromHouseId: uuid('from_house_id').references(() => houses.id),
    toHouseId: uuid('to_house_id').references(() => houses.id),
    /** Ссылка на бумагу: накладная, акт, чек. */
    docRef: text('doc_ref'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('inventory_movements_item_idx').on(table.itemId, table.date)],
);

export const inventoryAuditStatusEnum = pgEnum('inventory_audit_status', ['draft', 'closed']);

/**
 * Инвентаризация дома: ведомость «по учёту / по факту / расхождение».
 * Закрытие превращает расхождения в движения `audit_adjust`.
 */
export const inventoryAudits = pgTable(
  'inventory_audits',
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
    date: date('date').notNull(),
    status: inventoryAuditStatusEnum('status').notNull().default('draft'),
    createdBy: uuid('created_by').references(() => users.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('inventory_audits_house_idx').on(table.houseId, table.date)],
);

export const inventoryAuditLines = pgTable(
  'inventory_audit_lines',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => inventoryAudits.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    /** Сколько числится по учёту на момент составления ведомости. */
    expectedQty: numeric('expected_qty', { precision: 12, scale: 2 }).notNull(),
    /** Сколько нашли; `null` — строку ещё не проверяли. */
    actualQty: numeric('actual_qty', { precision: 12, scale: 2 }),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('inventory_audit_lines_audit_idx').on(table.auditId, table.itemId)],
);

export type InventoryItem = typeof inventoryItems.$inferSelect;
export type NewInventoryItem = typeof inventoryItems.$inferInsert;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InventoryAudit = typeof inventoryAudits.$inferSelect;
export type InventoryAuditLine = typeof inventoryAuditLines.$inferSelect;
