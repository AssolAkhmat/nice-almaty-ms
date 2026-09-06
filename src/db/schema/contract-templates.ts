import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations';

/**
 * Шаблон договора (docs/02-DATA-MODEL.md, docs/04-MODULES/11-users-settings.md).
 *
 * Версионируется: подписанный договор должен оставаться воспроизводимым,
 * а правка шаблона не может задним числом изменить уже подписанное.
 * Активный шаблон в сети один — по нему собираются новые договоры.
 */
export const contractTemplates = pgTable(
  'contract_templates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    bodyHtml: text('body_html').notNull(),
    /** Токены, использованные в шаблоне: палитра проверяется при сохранении. */
    tokens: jsonb('tokens').notNull().default([]),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('contract_templates_org_version_unique').on(table.orgId, table.version)],
);

export type ContractTemplate = typeof contractTemplates.$inferSelect;
export type NewContractTemplate = typeof contractTemplates.$inferInsert;
