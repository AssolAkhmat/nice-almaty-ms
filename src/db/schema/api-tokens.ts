import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { houses } from './houses';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Токены API для ботов (docs/06-API.md, «Аутентификация»;
 * docs/02-DATA-MODEL.md, `api_tokens`).
 *
 * В базе лежит только хеш: значение показывается один раз при выдаче
 * и больше нигде не хранится. Токен всегда принадлежит сети, а домом
 * ограничивается отдельным полем — тем же способом, что и админ.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** Название для человека: по нему токен узнают в списке и отзывают. */
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Дом, которым ограничен токен; `null` — вся сеть. */
    houseId: uuid('house_id').references(() => houses.id),
    /**
     * Кто выдал. Права токена не могут превышать прав выдавшего
     * на момент выдачи — иначе токен стал бы способом их расширить.
     */
    createdBy: uuid('created_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* Поиск при каждом запросе идёт по хешу: он и есть точка входа. */
    index('api_tokens_hash_idx').on(table.tokenHash),
    index('api_tokens_org_idx').on(table.orgId, table.revokedAt),
  ],
);

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
