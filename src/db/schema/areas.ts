import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
  (table) => [
    index('areas_house_idx').on(table.houseId, table.sortOrder),
    /*
     * Опора для составного внешнего ключа `(area_id, house_id)` из других
     * таблиц: он даёт базе право отвергнуть зону чужого дома, не полагаясь
     * на проверку в сервисе. Сам по себе индекс избыточен — `id` и так
     * первичный ключ, — но без него PostgreSQL такой ключ не создаст.
     */
    uniqueIndex('areas_id_house_unique').on(table.id, table.houseId),
  ],
);

export type Area = typeof areas.$inferSelect;
export type NewArea = typeof areas.$inferInsert;
