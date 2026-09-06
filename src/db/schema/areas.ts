import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { houses } from './houses';

/**
 * Зона дома: жилая комната или общая зона (двор, кухня, туалет).
 * Ротации назначаются на зоны, места существуют только в жилых комнатах.
 */
export const areaTypeEnum = pgEnum('area_type', ['living', 'common']);

export const areas = pgTable(
  'areas',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    type: areaTypeEnum('type').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('areas_house_idx').on(table.houseId, table.sortOrder)],
);

export type Area = typeof areas.$inferSelect;
export type NewArea = typeof areas.$inferInsert;
