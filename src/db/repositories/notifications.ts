import { and, asc, count, eq, isNull, inArray, sql } from 'drizzle-orm';

import { ForbiddenError } from '@/lib/errors';
import { now } from '@/lib/time';

import { type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  notificationOutbox,
  notifications,
  pushSubscriptions,
  type Notification,
  type NotificationOutboxRow,
  type PushSubscription,
} from '../schema';

/**
 * Уведомления, очередь доставки и подписки на push (docs/02-DATA-MODEL.md).
 *
 * Уведомление принадлежит человеку: он его читает, он же помечает
 * прочитанным. Чужое неотличимо от несуществующего (P1-1) — списком
 * оно не отдаётся, а попытка отметить его чужой рукой отклоняется.
 */
export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: Record<string, string>;
  body: Record<string, string>;
  payload?: unknown;
}

export async function createNotification(
  context: AccessContext,
  input: CreateNotificationInput,
  executor: Executor = getDb(),
): Promise<Notification> {
  const [notification] = await executor
    .insert(notifications)
    .values({
      orgId: context.orgId,
      userId: input.userId,
      type: input.type,
      titleI18n: input.title,
      bodyI18n: input.body,
      payload: input.payload ?? {},
    })
    .returning();

  if (notification === undefined) {
    throw new Error('Уведомление не создано');
  }

  return notification;
}

export interface NotificationFilter {
  userId?: string;
  type?: string;
  /** Только непрочитанные: центр уведомлений открывается с них. */
  unreadOnly?: boolean;
}

/** Адресат, чьи уведомления контекст вправе читать: только он сам. */
function addressee(context: AccessContext, requested?: string): string | null {
  if (requested === undefined || requested === context.userId) {
    return context.userId;
  }

  /*
   * Уведомление — личное сообщение, а не запись о жильце: ни админ, ни
   * суперадмин чужую переписку не читают. Отказ выглядит как пустой
   * список, а не как «нет прав»: иначе перебором адресатов читался бы
   * состав сети (P1-1).
   */
  return null;
}

export async function listNotifications(
  context: AccessContext,
  filter: NotificationFilter = {},
  executor: Executor = getDb(),
): Promise<Notification[]> {
  const userId = addressee(context, filter.userId);

  if (userId === null) {
    return [];
  }

  const conditions = [eq(notifications.orgId, context.orgId), eq(notifications.userId, userId)];

  if (filter.type !== undefined) {
    conditions.push(eq(notifications.type, filter.type));
  }

  if (filter.unreadOnly === true) {
    conditions.push(isNull(notifications.readAt));
  }

  return executor
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(sql`${notifications.createdAt} desc`, asc(notifications.id));
}

export async function countUnread(
  context: AccessContext,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ value: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, context.orgId),
        eq(notifications.userId, context.userId),
        isNull(notifications.readAt),
      ),
    );

  return row?.value ?? 0;
}

export async function markNotificationRead(
  context: AccessContext,
  notificationId: string,
  executor: Executor = getDb(),
): Promise<Notification> {
  const [existing] = await executor
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.orgId, context.orgId)))
    .limit(1);

  if (existing === undefined || existing.userId !== context.userId) {
    throw new ForbiddenError('Уведомление принадлежит другому пользователю');
  }

  const [updated] = await executor
    .update(notifications)
    .set({ readAt: existing.readAt ?? now() })
    .where(eq(notifications.id, notificationId))
    .returning();

  return updated ?? existing;
}

/**
 * Постановка в очередь: одна строка на канал.
 *
 * Повторная постановка того же канала ничего не делает — задание разбора
 * идёт каждые пять минут, и повторы для него норма, а не сбой.
 */
export async function queueOutbox(
  notificationId: string,
  channels: readonly ('inapp' | 'webpush' | 'whatsapp')[],
  executor: Executor = getDb(),
): Promise<void> {
  if (channels.length === 0) {
    return;
  }

  await executor
    .insert(notificationOutbox)
    .values(channels.map((channel) => ({ notificationId, channel })))
    .onConflictDoNothing({
      target: [notificationOutbox.notificationId, notificationOutbox.channel],
    });
}

export interface OutboxFilter {
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  limit: number;
  channels?: readonly ('inapp' | 'webpush' | 'whatsapp')[];
}

export async function listOutbox(
  filter: OutboxFilter,
  executor: Executor = getDb(),
): Promise<NotificationOutboxRow[]> {
  const conditions = [eq(notificationOutbox.status, filter.status)];

  if (filter.channels !== undefined && filter.channels.length > 0) {
    conditions.push(inArray(notificationOutbox.channel, [...filter.channels]));
  }

  return executor
    .select()
    .from(notificationOutbox)
    .where(and(...conditions))
    .orderBy(asc(notificationOutbox.createdAt), asc(notificationOutbox.id))
    .limit(filter.limit);
}

export async function markOutboxSent(
  outboxId: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(notificationOutbox)
    .set({
      status: 'sent',
      sentAt: now(),
      attempts: sql`${notificationOutbox.attempts} + 1`,
      error: null,
      updatedAt: now(),
    })
    .where(eq(notificationOutbox.id, outboxId));
}

export async function markOutboxFailed(
  outboxId: string,
  error: string,
  final: boolean,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(notificationOutbox)
    .set({
      status: final ? 'failed' : 'queued',
      attempts: sql`${notificationOutbox.attempts} + 1`,
      error,
      updatedAt: now(),
    })
    .where(eq(notificationOutbox.id, outboxId));
}

/** Канал, который не подключён: заглушка честно помечает строку пропущенной. */
export async function markOutboxSkipped(
  outboxId: string,
  reason: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(notificationOutbox)
    .set({ status: 'skipped', error: reason, updatedAt: now() })
    .where(eq(notificationOutbox.id, outboxId));
}

export async function requireNotification(
  notificationId: string,
  executor: Executor = getDb(),
): Promise<Notification | null> {
  const [notification] = await executor
    .select()
    .from(notifications)
    .where(eq(notifications.id, notificationId))
    .limit(1);

  return notification ?? null;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

/**
 * Подписка того, кто её заводит: адресат берётся из контекста, а не из
 * запроса. Иначе браузер одного жильца получал бы уведомления другого.
 */
export async function putPushSubscription(
  context: AccessContext,
  input: PushSubscriptionInput,
  executor: Executor = getDb(),
): Promise<PushSubscription> {
  const [subscription] = await executor
    .insert(pushSubscriptions)
    .values({
      userId: context.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: [pushSubscriptions.endpoint],
      set: {
        userId: context.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        revokedAt: null,
        updatedAt: now(),
      },
    })
    .returning();

  if (subscription === undefined) {
    throw new Error('Подписка не сохранена');
  }

  return subscription;
}

export async function listPushSubscriptions(
  userId: string,
  executor: Executor = getDb(),
): Promise<PushSubscription[]> {
  return executor
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)))
    .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));
}

/** Отзыв по адресу: push-сервис сообщает именно его, а не пользователя. */
export async function revokePushSubscription(
  endpoint: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(pushSubscriptions)
    .set({ revokedAt: now(), updatedAt: now() })
    .where(eq(pushSubscriptions.endpoint, endpoint));
}
