import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { localeEnum, userRoleEnum, userStatusEnum, userThemeEnum } from './enums';
import { houses } from './houses';
import { organizations } from './organizations';

/**
 * Учётная запись. Создаётся только суперадмином, самостоятельной регистрации нет.
 * Роль и проживание — разные сущности (D11): дом здесь есть только у админа,
 * жилец связан с домом через проживание, которое появится в фазе 2.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** Нормализованный номер вида +7XXXXXXXXXX. */
    phone: text('phone').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull(),
    houseId: uuid('house_id').references(() => houses.id),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    /** Одноразовое разрешение сброса пароля живёт 24 часа. */
    passwordResetAllowedUntil: timestamp('password_reset_allowed_until', { withTimezone: true }),
    locale: localeEnum('locale').notNull().default('ru'),
    /** Личная настройка оформления; выбор переживает смену устройства. */
    theme: userThemeEnum('theme').notNull().default('system'),
    status: userStatusEnum('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_phone_unique').on(table.phone),
    /* Один админ — один дом; у суперадмина и жильца дома в учётной записи нет. */
    check(
      'users_admin_has_house',
      sql`(${table.role} = 'admin' and ${table.houseId} is not null) or (${table.role} <> 'admin' and ${table.houseId} is null)`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
