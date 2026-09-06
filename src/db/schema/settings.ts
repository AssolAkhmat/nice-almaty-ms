import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { settingsScopeEnum } from './enums';

/**
 * Настройки сети и дома. Уровень задаётся парой (scope, scope_id):
 * значение дома переопределяет значение сети (docs/04-MODULES/11-users-settings.md).
 */
export const settings = pgTable(
  'settings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    scope: settingsScopeEnum('scope').notNull(),
    scopeId: uuid('scope_id').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('settings_scope_key_unique').on(table.scope, table.scopeId, table.key)],
);

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
