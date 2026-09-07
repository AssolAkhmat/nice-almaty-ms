import { pushPublicKey, resolveSenders } from '@/adapters/notify';
import { getDb, type Executor } from '@/db/client';
import {
  countUnread,
  createNotification,
  findPushSubscription,
  listNotifications,
  listOutbox,
  listPushSubscriptions,
  markNotificationRead,
  markOutboxFailed,
  markOutboxSent,
  markOutboxSkipped,
  putPushSubscription,
  queueOutbox,
  requireNotification,
  revokePushSubscription,
  type NotificationFilter,
  type PushSubscriptionInput,
} from '@/db/repositories/notifications';
import { findUserInOrg } from '@/db/repositories/users';
import {
  channelsFor,
  missingLocales,
  nextDeliveryState,
  type DeliveryOutcome,
  type LocalizedText,
  type NotificationChannel,
} from '@/domain/notifications';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/config';
import { logger } from '@/lib/logger';

import type { DeliveryMessage, SenderRegistry } from '@/adapters/notify/types';
import type { AccessContext } from '@/db/access';
import type { Notification, PushSubscription } from '@/db/schema';

/**
 * Ядро очереди уведомлений (docs/01-ARCHITECTURE.md, «Планировщик»;
 * docs/02-DATA-MODEL.md — «Файлы, уведомления, система»).
 *
 * Уведомление ставится один раз, а доставляется по каналам: у каждого
 * своя строка очереди и своя судьба. Отправитель уведомления ничего
 * не знает о каналах, каналы ничего не знают об очереди, очередь ничего
 * не знает о том, кто и почему уведомляет.
 */
export const NOTIFICATIONS_DISPATCH_JOB = 'notifications-dispatch';

/**
 * Сколько строк берётся за прогон.
 *
 * Пачка идёт в одной транзакции, а доставка — это сеть: чем больше пачка,
 * тем дольше открыта транзакция. Двадцать пять строк каждые пять минут —
 * это триста уведомлений в час, с запасом больше, чем даёт сеть домов.
 */
export const DISPATCH_BATCH_LIMIT = 25;

export interface NotifyInput {
  /** Адресат: человек, а не дом и не роль. */
  userId: string;
  /** Код события: `rotation.reminder`, `invoice.issued` и прочие. */
  type: string;
  title: LocalizedText;
  body: LocalizedText;
  payload?: Record<string, unknown>;
  /**
   * Каналы, если они известны вызывающему. Обычно не задаются: набор
   * выводится из подписок адресата.
   */
  channels?: readonly NotificationChannel[];
}

function assertLocalized(text: LocalizedText, field: string): void {
  const missing = missingLocales(text);

  if (missing.length > 0) {
    /*
     * Локаль выбирает читающий, а не отправитель: уведомление без
     * казахского текста стало бы пустым экраном у жильца с казахским
     * языком. Пустоту дешевле поймать здесь, чем у него.
     */
    throw new ValidationError(`Текст уведомления не заполнен в локалях: ${missing.join(', ')}`, {
      field,
      missing,
    });
  }
}

/**
 * Постановка уведомления: факт и очередь доставки в одном изменении.
 *
 * Контекст здесь — отправитель, а не адресат: сеть берётся из него,
 * а адресат проверяется на принадлежность той же сети. Уведомление
 * человеку из чужой сети — не «нет прав», а «нет такого адресата» (P6-8).
 */
export async function notify(
  context: AccessContext,
  input: NotifyInput,
  executor: Executor = getDb(),
): Promise<Notification> {
  assertLocalized(input.title, 'title');
  assertLocalized(input.body, 'body');

  const addressee = await findUserInOrg(context.orgId, input.userId, executor);

  if (addressee === null) {
    throw new NotFoundError('Адресат уведомления не найден');
  }

  const channels =
    input.channels ??
    channelsFor({
      hasPushSubscription: (await listPushSubscriptions(input.userId, executor)).length > 0,
    });

  const notification = await createNotification(
    context,
    {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      payload: input.payload ?? {},
    },
    executor,
  );

  await queueOutbox(notification.id, channels, executor);

  return notification;
}

/** Список уведомлений читающего: чужие для него не существуют. */
export async function listInbox(
  context: AccessContext,
  filter: NotificationFilter = {},
  executor: Executor = getDb(),
): Promise<Notification[]> {
  return listNotifications(context, { ...filter, userId: context.userId }, executor);
}

export async function unreadCount(
  context: AccessContext,
  executor: Executor = getDb(),
): Promise<number> {
  return countUnread(context, executor);
}

export async function markRead(
  context: AccessContext,
  notificationId: string,
  executor: Executor = getDb(),
): Promise<Notification> {
  return markNotificationRead(context, notificationId, executor);
}

/**
 * Публичный ключ VAPID для браузера: без него подписка не оформляется.
 * `null` значит, что push в этом окружении не настроен, — экран профиля
 * тогда честно говорит, что канал недоступен, а не молчит.
 */
export function pushKeyForBrowser(): string | null {
  return pushPublicKey();
}

/** Подписка браузера: адресат берётся из контекста, а не из запроса. */
export async function subscribeToPush(
  context: AccessContext,
  input: PushSubscriptionInput,
  executor: Executor = getDb(),
): Promise<PushSubscription> {
  return putPushSubscription(context, input, executor);
}

/**
 * Отписка по адресу.
 *
 * Адрес подписки уникален глобально, поэтому владелец проверяется явно:
 * иначе чужой браузер отключался бы от уведомлений по одному лишь знанию
 * его адреса. Несуществующая подписка — «не найдено», а не тихий успех:
 * человек нажал «отключить» и вправе знать, что ничего не случилось.
 */
export async function unsubscribeFromPush(
  context: AccessContext,
  endpoint: string,
  executor: Executor = getDb(),
): Promise<void> {
  const subscription = await findPushSubscription(endpoint, executor);

  if (subscription === null || subscription.userId !== context.userId) {
    throw new NotFoundError('Подписка не найдена');
  }

  await revokePushSubscription(endpoint, executor);
}

/** Живые подписки читающего: экран профиля показывает, сколько их. */
export async function listOwnPushSubscriptions(
  context: AccessContext,
  executor: Executor = getDb(),
): Promise<PushSubscription[]> {
  return listPushSubscriptions(context.userId, executor);
}

export interface DispatchDeps {
  executor?: Executor;
  /** Каналы доставки. По умолчанию — подключённые в этом окружении. */
  senders?: SenderRegistry;
  limit?: number;
}

export interface DispatchResult {
  /** Сколько строк взято из очереди. */
  taken: number;
  sent: number;
  /** Временная помеха: строка вернулась в очередь до следующего прогона. */
  retried: number;
  failed: number;
  /** Канал не подключён: доставки не было и не будет. */
  skipped: number;
}

function messageOf(notification: Notification, locale: Locale): DeliveryMessage {
  return {
    notificationId: notification.id,
    userId: notification.userId,
    type: notification.type,
    title: notification.titleI18n as LocalizedText,
    body: notification.bodyI18n as LocalizedText,
    payload: notification.payload,
    locale,
  };
}

/**
 * Язык адресата для каналов, показывающих один текст.
 *
 * Пачка почти всегда про одного-двух человек — уведомления ставятся
 * заданиями подряд, — поэтому профиль читается один раз на прогон.
 * Пропавший адресат берёт язык сети по умолчанию: текст всё равно
 * заполнен во всех трёх локалях.
 */
function localeReader(executor: Executor): (notification: Notification) => Promise<Locale> {
  const cache = new Map<string, Locale>();

  return async (notification: Notification) => {
    const known = cache.get(notification.userId);

    if (known !== undefined) {
      return known;
    }

    const user = await findUserInOrg(notification.orgId, notification.userId, executor);
    const locale = user?.locale ?? DEFAULT_LOCALE;
    cache.set(notification.userId, locale);

    return locale;
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Разбор очереди `notifications-dispatch` (каждые пять минут).
 *
 * Своей записи в `job_runs` у задания нет, и это осознанно (P6-6):
 * идемпотентность здесь держит не период, а сама строка очереди —
 * доставленная больше не берётся. Период в пять минут дал бы сто тысяч
 * строк учёта в год и не добавил бы ни одной гарантии.
 */
export async function dispatchNotifications(deps: DispatchDeps = {}): Promise<DispatchResult> {
  const executor = deps.executor ?? getDb();
  const senders = deps.senders ?? resolveSenders();
  const limit = deps.limit ?? DISPATCH_BATCH_LIMIT;
  const log = logger.child({ job: NOTIFICATIONS_DISPATCH_JOB });

  return executor.transaction(async (tx) => {
    const batch = await listOutbox({ status: 'queued', limit, lock: true }, tx);
    const localeOf = localeReader(tx);
    const result: DispatchResult = {
      taken: batch.length,
      sent: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
    };

    for (const row of batch) {
      const notification = await requireNotification(row.notificationId, tx);

      if (notification === null) {
        // Строка без уведомления — след потерянных данных: повторять нечего.
        await markOutboxFailed(row.id, 'Уведомление не найдено', true, tx);
        result.failed += 1;
        continue;
      }

      const sender = senders[row.channel];
      let outcome: DeliveryOutcome;

      if (sender === undefined) {
        outcome = { kind: 'skipped', reason: `Канал ${row.channel} не подключён` };
      } else {
        try {
          outcome = await sender.deliver(messageOf(notification, await localeOf(notification)), {
            executor: tx,
          });
        } catch (error) {
          /*
           * Упавший канал не должен ронять пачку: остальные строки
           * доставляются, а эта ждёт следующего прогона. Исключение —
           * всегда временная помеха: канал, знающий, что адресата
           * больше нет, говорит это исходом, а не броском.
           */
          outcome = { kind: 'retry', error: errorText(error) };
        }
      }

      const state = nextDeliveryState(row.attempts, outcome);

      switch (state.status) {
        case 'sent':
          await markOutboxSent(row.id, tx);
          result.sent += 1;
          break;
        case 'skipped':
          await markOutboxSkipped(row.id, state.error ?? '', tx);
          result.skipped += 1;
          break;
        case 'queued':
          await markOutboxFailed(row.id, state.error ?? '', false, tx);
          result.retried += 1;
          break;
        case 'failed':
          await markOutboxFailed(row.id, state.error ?? '', true, tx);
          result.failed += 1;
          break;
      }
    }

    if (result.taken > 0) {
      log.info(result, 'очередь разобрана');
    }

    return result;
  });
}
