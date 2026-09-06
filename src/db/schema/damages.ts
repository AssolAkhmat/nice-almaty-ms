import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { files } from './files';
import { houses } from './houses';
import { organizations } from './organizations';
import { residencies } from './residencies';
import { users } from './users';

/**
 * Ущерб и его деление (docs/02-DATA-MODEL.md, docs/03-BUSINESS-RULES.md §8).
 *
 * Доли сохраняются поимённо: жилец видит все списания своего депозита
 * с названием и суммой, а сторно возвращает ровно те суммы, что списаны.
 */
export const damageSplitModeEnum = pgEnum('damage_split_mode', [
  'single',
  'room',
  'all',
  'all_except',
  'custom',
]);

export const damages = pgTable(
  'damages',
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
    title: text('title').notNull(),
    description: text('description'),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    receiptFileId: uuid('receipt_file_id').references(() => files.id),
    splitMode: damageSplitModeEnum('split_mode').notNull(),
    /** Кого касается режим: список жильцов или комната. */
    splitConfig: jsonb('split_config').notNull().default({}),
    /** Излишек округления — в фонд дома (§0). */
    surplus: bigint('surplus', { mode: 'number' }).notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('damages_house_idx').on(table.houseId, table.createdAt)],
);

export const damageShares = pgTable(
  'damage_shares',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    damageId: uuid('damage_id')
      .notNull()
      .references(() => damages.id),
    residencyId: uuid('residency_id')
      .notNull()
      .references(() => residencies.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('damage_shares_damage_residency_unique').on(table.damageId, table.residencyId),
  ],
);

export type Damage = typeof damages.$inferSelect;
export type NewDamage = typeof damages.$inferInsert;
export type DamageShare = typeof damageShares.$inferSelect;
export type NewDamageShare = typeof damageShares.$inferInsert;
