import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { PROFILE_FIELD_TYPES } from '@/domain/profile-fields';

import { organizations } from './organizations';
import { users } from './users';

/**
 * Дополнительные поля профиля (указание владельца от 21 сентября 2026).
 *
 * Суперадмин объявляет поле — название, тип, обязательность, — оно появляется
 * в форме заселения и становится токеном шаблона договора `profile.<код>`.
 *
 * Типов ровно пять, а не «любой»: с произвольным типом проверка значения
 * превратилась бы в гадание, а договор печатал бы что угодно. Шестой тип
 * отвергает база — перечислением, а не проверкой в сервисе.
 */
export const profileFieldTypeEnum = pgEnum('profile_field_type', PROFILE_FIELD_TYPES);

export const profileFieldDefs = pgTable(
  'profile_field_defs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /**
     * Машинный код: он же хвост токена договора `profile.<код>`. Латиница
     * в нижнем регистре, цифры и подчёркивание — иначе токен не разберётся
     * и шаблон начнёт печатать сам себя.
     */
    code: text('code').notNull(),
    /** Название на трёх локалях: поля заводит суперадмин, а не разработчик. */
    nameI18n: jsonb('name_i18n').notNull().default({}),
    type: profileFieldTypeEnum('type').notNull(),
    isRequired: boolean('is_required').notNull().default(false),
    /** Варианты для типа `choice`; у остальных типов пусто. */
    options: jsonb('options').notNull().default([]),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Архивация вместо удаления: значения остаются в уже подписанных договорах
     * и в истории. Код архивированного поля не освобождается — уникальность
     * ниже стоит без условия на `archived_at` намеренно, иначе токен
     * `profile.<код>` значил бы в старом договоре одно, а в новом другое.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('profile_field_defs_org_code_unique').on(table.orgId, table.code),
    index('profile_field_defs_org_idx').on(table.orgId, table.sortOrder),
    /* Опора для составного внешнего ключа `(field_id, org_id)` из значений. */
    uniqueIndex('profile_field_defs_id_org_unique').on(table.id, table.orgId),
    check('profile_field_defs_code_shape', sql`${table.code} ~ '^[a-z][a-z0-9_]{0,38}$'`),
    /* Название — объект локалей, а не строка и не список. */
    check('profile_field_defs_name_object', sql`jsonb_typeof(${table.nameI18n}) = 'object'`),
    /*
     * Варианты есть ровно у выбора из списка. Выбор без вариантов — поле,
     * которое нельзя заполнить; варианты у числа — обещание, которого
     * никто не проверяет.
     */
    check(
      'profile_field_defs_options_shape',
      sql`jsonb_typeof(${table.options}) = 'array' and case when ${table.type} = 'choice' then jsonb_array_length(${table.options}) > 0 else jsonb_array_length(${table.options}) = 0 end`,
    ),
  ],
);

/**
 * Значение объявленного поля у жильца.
 *
 * Отдельная таблица, а не JSONB в `resident_profiles`: правка значения обязана
 * попадать в `audit_log` построчно, а по объявленному полю нужен поиск.
 *
 * Значение хранится текстом в единой записи на тип: число — без пробелов,
 * дата — `ГГГГ-ММ-ДД`, да/нет — `true`/`false`, выбор — код варианта, строка —
 * как введена (D31). Договор печатает текст, и разбор нужен одному месту —
 * сервису, который это значение показывает.
 */
export const profileFieldValues = pgTable(
  'profile_field_values',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /**
     * Сеть хранится рядом со значением и связана составными ключами с полем
     * и с человеком: так база сама отвергает значение поля чужой сети,
     * не полагаясь на фильтр в сервисе.
     */
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('profile_field_values_user_field_unique').on(table.userId, table.fieldId),
    index('profile_field_values_field_idx').on(table.fieldId, table.value),
    foreignKey({
      columns: [table.fieldId, table.orgId],
      foreignColumns: [profileFieldDefs.id, profileFieldDefs.orgId],
      name: 'profile_field_values_field_org_fk',
    }),
    foreignKey({
      columns: [table.userId, table.orgId],
      foreignColumns: [users.id, users.orgId],
      name: 'profile_field_values_user_org_fk',
    }),
  ],
);

export type ProfileFieldDef = typeof profileFieldDefs.$inferSelect;
export type NewProfileFieldDef = typeof profileFieldDefs.$inferInsert;
export type ProfileFieldValue = typeof profileFieldValues.$inferSelect;
export type NewProfileFieldValue = typeof profileFieldValues.$inferInsert;
export type { ProfileFieldType } from '@/domain/profile-fields';
