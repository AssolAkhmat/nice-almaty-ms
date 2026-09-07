import type { Executor } from '@/db/client';
import type { DeliveryOutcome, LocalizedText, NotificationChannel } from '@/domain/notifications';

/**
 * Канал доставки уведомления (docs/01-ARCHITECTURE.md, адаптеры `notify/*`).
 *
 * Канал получает готовое сообщение и отвечает исходом, а не бросает
 * исключение: разница между «повторить» и «адресата больше нет» — это
 * решение канала, и терять её в общем `catch` нельзя.
 */
export interface DeliveryMessage {
  notificationId: string;
  /** Адресат: канал сам решает, куда именно ему писать. */
  userId: string;
  type: string;
  title: LocalizedText;
  body: LocalizedText;
  payload: unknown;
}

export interface DeliveryDeps {
  /**
   * Транзакция разбора очереди. Каналу она нужна, чтобы отметить
   * побочный след доставки — например, отозвать снятую подписку —
   * в том же изменении, что и статус строки очереди.
   */
  executor: Executor;
}

export interface NotificationSender {
  readonly channel: NotificationChannel;
  deliver(message: DeliveryMessage, deps: DeliveryDeps): Promise<DeliveryOutcome>;
}

/**
 * Каналы, подключённые в этом окружении. Неполный по устройству:
 * неподключённый канал — обычное состояние, а не сбой.
 */
export type SenderRegistry = Partial<Record<NotificationChannel, NotificationSender>>;
