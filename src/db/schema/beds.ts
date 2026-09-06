import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { areas } from './areas';
import { houses } from './houses';

/** Ярус спального места: верхний или нижний. */
export const bedTierEnum = pgEnum('bed_tier', ['upper', 'lower']);

/**
 * Спальное место в жилой комнате (docs/02-DATA-MODEL.md).
 * Цена по умолчанию — целое число тенге; индивидуальная цена жильца
 * задаётся в назначении места, а не здесь.
 */
export const beds = pgTable(
  'beds',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    areaId: uuid('area_id')
      .notNull()
      .references(() => areas.id),
    label: text('label').notNull(),
    tier: bedTierEnum('tier').notNull(),
    number: integer('number').notNull(),
    defaultPrice: bigint('default_price', { mode: 'number' }).notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('beds_area_number_tier_unique').on(table.areaId, table.number, table.tier),
    index('beds_house_idx').on(table.houseId),
  ],
);

export type Bed = typeof beds.$inferSelect;
export type NewBed = typeof beds.$inferInsert;
