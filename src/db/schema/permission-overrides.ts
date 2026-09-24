import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { organizations } from './organizations';
import { users } from './users';

/**
 * Переопределения полномочий админа (указание владельца, 23 сентября 2026).
 *
 * Права перестают быть только кодом и становятся ещё и данными. Матрица
 * `src/lib/permissions.ts` остаётся источником того, **что вообще бывает**;
 * эта таблица говорит, что из положенного роли «админ» включено в конкретной
 * сети и у конкретного человека.
 *
 * Две области в одной таблице, и различает их `user_id`:
 * - `user_id IS NULL` — правило сети: касается всех админов;
 * - `user_id` задан — правило для одного админа, оно сильнее сетевого.
 *
 * Суперадмина не касается никогда: у него нет дома, и урезать сеть самому
 * себе — не полномочие, а способ запереть дверь изнутри.
 *
 * Отдельная таблица, а не колонка-массив у пользователя и не `settings`:
 * изменение прав обязано попадать в `audit_log` построчно — кому, что,
 * когда. Массив в одной строке дал бы в журнале «было одно, стало другое»,
 * и разбирать это пришлось бы глазами.
 */
export const permissionOverrides = pgTable(
  'permission_overrides',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** Пусто — правило всей сети. Задан — правило одного админа. */
    userId: uuid('user_id').references(() => users.id),
    /** Действие из `ACTIONS`; текстом, потому что перечень живёт в коде. */
    action: text('action').notNull(),
    allowed: boolean('allowed').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('permission_overrides_org_idx').on(table.orgId),
    /*
     * Два частичных ключа вместо одного: PostgreSQL считает NULL разными
     * значениями, и обычный уникальный ключ по `(org_id, user_id, action)`
     * пропустил бы два сетевых правила на одно действие.
     */
    uniqueIndex('permission_overrides_network_unique')
      .on(table.orgId, table.action)
      .where(sql`${table.userId} is null`),
    uniqueIndex('permission_overrides_user_unique')
      .on(table.orgId, table.userId, table.action)
      .where(sql`${table.userId} is not null`),
  ],
);

export type PermissionOverride = typeof permissionOverrides.$inferSelect;
export type NewPermissionOverride = typeof permissionOverrides.$inferInsert;
