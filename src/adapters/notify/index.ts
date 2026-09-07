import { loadEnv } from '@/lib/env/load';

import { inappSender } from './inapp';
import { createWebPushSender } from './webpush';
import { whatsappStubSender } from './whatsapp';

import type { SenderRegistry } from './types';
import type { Env } from '@/lib/env/schema';

/**
 * Каналы доставки уведомлений (docs/01-ARCHITECTURE.md, адаптеры `notify/*`).
 *
 * Единственное место, где разбор очереди узнаёт о существовании каналов:
 * сам он про `inapp`, `webpush` и WhatsApp ничего не знает и знать не должен.
 * Канал без ключей не подключается вовсе, и его строки очереди честно
 * помечаются `skipped` с именем канала, а не копятся в ожидании
 * отправителя, которого нет (P6-5).
 */
export function resolveSenders(env: Env = loadEnv()): SenderRegistry {
  const senders: SenderRegistry = {
    inapp: inappSender,
    whatsapp: whatsappStubSender,
  };

  const publicKey = env.WEBPUSH_PUBLIC_KEY;
  const privateKey = env.WEBPUSH_PRIVATE_KEY;
  const subject = env.WEBPUSH_SUBJECT;

  /*
   * Схема окружения требует ключи Web Push целиком или не требует вовсе,
   * но проверка повторена здесь: без неё канал собрался бы с пустым
   * ключом и падал бы на подписи у каждого уведомления.
   */
  if (publicKey !== undefined && privateKey !== undefined && subject !== undefined) {
    senders.webpush = createWebPushSender({ publicKey, privateKey, subject });
  }

  return senders;
}

/**
 * Публичный ключ VAPID для браузера.
 *
 * Он не секрет — подписка без него не оформляется, — но и не константа
 * сборки: `NEXT_PUBLIC_*` впекается в бандл, и смена ключа потребовала бы
 * пересборки на всех окружениях. Поэтому ключ отдаёт сервер в момент
 * подписки, как и любое другое значение окружения (P6-11).
 */
export function pushPublicKey(env: Env = loadEnv()): string | null {
  return env.WEBPUSH_PUBLIC_KEY ?? null;
}

export { inappSender } from './inapp';
export { classifyPushResponse, createWebPushSender } from './webpush';
export { whatsappStubSender } from './whatsapp';
export type { DeliveryDeps, DeliveryMessage, NotificationSender, SenderRegistry } from './types';
