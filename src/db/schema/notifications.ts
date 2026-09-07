import { sql } from 'drizzle-orm';
import {
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

import { organizations } from './organizations';
import { users } from './users';

/**
 * Уведомления и их доставка (docs/02-DATA-MODEL.md, раздел «Файлы,
 * уведомления, система»; docs/01-ARCHITECTURE.md — адаптеры `notify/*`).
 *
 * Уведомление — это факт «человеку сообщили», а не отправленное сообщение.
 * Каналов у одного факта несколько, и у каждого своя судьба: push мог
 * не дойти, а в приложении он уже виден. Поэтому очередь отдельной таблицей.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Код события: `rotation.reminder`, `invoice.issued` и прочие. */
    type: text('type').notNull(),
    /** Заголовок в трёх локалях: язык выбирает читающий, а не отправитель. */
    titleI18n: jsonb('title_i18n').notNull(),
    bodyI18n: jsonb('body_i18n').notNull(),
    /** Ссылка и идентификаторы для перехода из уведомления. */
    payload: jsonb('payload').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('notifications_user_idx').on(table.userId, table.createdAt)],
);

export const notificationChannelEnum = pgEnum('notification_channel', [
  'inapp',
  'webpush',
  'whatsapp',
]);

export const notificationStatusEnum = pgEnum('notification_status', [
  'queued',
  'sent',
  'failed',
  'skipped',
]);

/**
 * Очередь доставки: одна строка на канал.
 *
 * Уникальность `(notification_id, channel)` держит идемпотентность:
 * повторная постановка того же уведомления не отправит его дважды —
 * а повторов будет много, задание разбора идёт каждые пять минут.
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id),
    channel: notificationChannelEnum('channel').notNull(),
    status: notificationStatusEnum('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_outbox_channel_unique').on(table.notificationId, table.channel),
    index('notification_outbox_status_idx').on(table.status, table.createdAt),
  ],
);

/**
 * Подписка браузера на push.
 *
 * Адрес подписки уникален глобально: браузер выдаёт его сам, и один
 * и тот же адрес не может принадлежать двум людям. Отозванная остаётся
 * строкой — по ней видно, что подписка была и когда её сняли.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('push_subscriptions_endpoint_unique').on(table.endpoint),
    index('push_subscriptions_user_idx').on(table.userId, table.revokedAt),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
