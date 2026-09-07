import type { NotificationSender } from './types';

/**
 * WhatsApp: заглушка, а не канал.
 *
 * Отправка требует договора с провайдером Business API — это внешнее
 * обязательство, которое принимает владелец, а не разработка (CLAUDE.md §8,
 * пункт 3). Пока его нет, заглушка честно говорит `skipped` с причиной:
 * молчаливое «отправлено» было бы хуже отсутствия канала, потому что
 * по журналу выглядело бы доставкой.
 */
export const whatsappStubSender: NotificationSender = {
  channel: 'whatsapp',
  deliver: () =>
    Promise.resolve({
      kind: 'skipped',
      reason: 'Канал WhatsApp не подключён: нужен договор с провайдером Business API',
    }),
};
