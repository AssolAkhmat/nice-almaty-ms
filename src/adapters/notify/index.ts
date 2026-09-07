import type { SenderRegistry } from './types';

/**
 * Каналы доставки уведомлений (docs/01-ARCHITECTURE.md, адаптеры `notify/*`).
 *
 * Единственное место, где разбор очереди узнаёт о существовании каналов:
 * сам он про `inapp`, `webpush` и WhatsApp ничего не знает и знать не должен.
 * Пока не подключён ни один: строки очереди честно помечаются `skipped`
 * с указанием канала, а не копятся в ожидании отправителя, которого нет (P6-5).
 */
export function resolveSenders(): SenderRegistry {
  return {};
}

export type { DeliveryDeps, DeliveryMessage, NotificationSender, SenderRegistry } from './types';
