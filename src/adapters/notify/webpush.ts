import { listPushSubscriptions, revokePushSubscription } from '@/db/repositories/notifications';
import {
  encryptPushPayload,
  toArrayBuffer,
  vapidAuthorization,
  VAPID_TOKEN_TTL_MS,
  type VapidKeys,
} from '@/lib/crypto/webpush';
import { logger } from '@/lib/logger';
import { now, plusMilliseconds } from '@/lib/time';

import type { DeliveryMessage, NotificationSender } from './types';
import type { DeliveryOutcome } from '@/domain/notifications';

/**
 * Web Push (docs/01-ARCHITECTURE.md, адаптеры `notify/*`).
 *
 * Одна строка очереди — одно уведомление, но подписок у человека может
 * быть несколько: телефон и ноутбук. Строка считается доставленной,
 * если её приняла хотя бы одна: получить уведомление дважды не страшно,
 * не получить вовсе — страшно.
 */

/** Сутки: напоминание о ротации, доставленное позже, уже не напоминание. */
const TTL_SECONDS = 24 * 60 * 60;

export type PushResponseKind = 'delivered' | 'gone' | 'retry' | 'permanent';

/**
 * Что означает ответ push-сервиса.
 *
 * 404 и 410 — «подписки больше нет»: браузер её снял, и повторять
 * бессмысленно, строку подписки надо закрыть. 408, 429 и пятисотые —
 * временная помеха, ждём следующего прогона. Остальные четырёхсотые —
 * наша ошибка (не тот ключ VAPID, слишком длинное тело): повтор её
 * не исправит, и попытки на неё тратить незачем (P6-10).
 */
export function classifyPushResponse(status: number): PushResponseKind {
  if (status >= 200 && status < 300) {
    return 'delivered';
  }

  if (status === 404 || status === 410) {
    return 'gone';
  }

  if (status === 408 || status === 429 || status >= 500) {
    return 'retry';
  }

  return 'permanent';
}

/** Что видит service worker: заголовок, текст и куда вести по нажатию. */
function payloadOf(message: DeliveryMessage): string {
  return JSON.stringify({
    id: message.notificationId,
    type: message.type,
    title: message.title[message.locale],
    body: message.body[message.locale],
    payload: message.payload,
  });
}

export interface WebPushDeps {
  /** Подменяется в тестах: живого push-сервиса у прогона нет. */
  fetch?: typeof fetch;
}

export function createWebPushSender(keys: VapidKeys, deps: WebPushDeps = {}): NotificationSender {
  const send = deps.fetch ?? globalThis.fetch;

  return {
    channel: 'webpush',
    deliver: async (message, { executor }): Promise<DeliveryOutcome> => {
      const log = logger.child({ channel: 'webpush', notification: message.notificationId });
      const subscriptions = await listPushSubscriptions(message.userId, executor);

      if (subscriptions.length === 0) {
        return { kind: 'skipped', reason: 'У адресата нет подписки на push' };
      }

      const body = payloadOf(message);
      const expiresAt = plusMilliseconds(now(), VAPID_TOKEN_TTL_MS);

      let delivered = 0;
      let gone = 0;
      let retry: string | null = null;
      let permanent: string | null = null;

      for (const subscription of subscriptions) {
        let status: number;

        try {
          const response = await send(subscription.endpoint, {
            method: 'POST',
            headers: {
              Authorization: await vapidAuthorization(subscription.endpoint, keys, expiresAt),
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              TTL: String(TTL_SECONDS),
              Urgency: 'normal',
            },
            body: toArrayBuffer(await encryptPushPayload(body, subscription)),
          });

          status = response.status;
        } catch (error) {
          // Сеть не ответила: это ровно та помеха, ради которой есть повтор.
          retry = error instanceof Error ? error.message : String(error);
          continue;
        }

        switch (classifyPushResponse(status)) {
          case 'delivered':
            delivered += 1;
            break;
          case 'gone':
            /*
             * Подписка снята на стороне браузера. Отзыв идёт по адресу:
             * push-сервис знает именно его, а не человека.
             */
            await revokePushSubscription(subscription.endpoint, executor);
            gone += 1;
            log.info({ status }, 'подписка отозвана push-сервисом');
            break;
          case 'retry':
            retry = `push-сервис ответил ${status}`;
            break;
          case 'permanent':
            permanent = `push-сервис отклонил сообщение: ${status}`;
            break;
        }
      }

      if (delivered > 0) {
        return { kind: 'sent' };
      }

      if (retry !== null) {
        return { kind: 'retry', error: retry };
      }

      if (permanent !== null) {
        return { kind: 'permanent', error: permanent };
      }

      return {
        kind: 'permanent',
        error: `Подписок больше нет: отозвано ${gone}`,
      };
    },
  };
}
