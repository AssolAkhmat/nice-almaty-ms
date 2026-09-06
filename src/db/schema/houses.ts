import { sql } from 'drizzle-orm';
import {
  bigint,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations';

/**
 * Физический дом. Слаг участвует в пути хранения документов
 * (`/{house_slug}/{residency_id}/{document_type}/`), поэтому уникален внутри сети.
 */
export const houses = pgTable(
  'houses',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    address: text('address'),
    /** Комендантский час, по умолчанию 23:00 (docs/03-BUSINESS-RULES.md §0). */
    curfewTime: time('curfew_time').notNull().default('23:00'),
    /** Депозит по умолчанию — 45 000 тенге, целое число тенге. */
    defaultDeposit: bigint('default_deposit', { mode: 'number' }).notNull().default(45_000),
    settings: jsonb('settings'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('houses_org_slug_unique').on(table.orgId, table.slug)],
);

export type House = typeof houses.$inferSelect;
export type NewHouse = typeof houses.$inferInsert;
