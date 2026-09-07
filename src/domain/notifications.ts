import { LOCALES, type Locale } from '@/lib/i18n/config';

/**
 * Ядро очереди уведомлений (docs/02-DATA-MODEL.md, раздел «Файлы,
 * уведомления, система»; docs/01-ARCHITECTURE.md — адаптеры `notify/*`).
 *
 * Здесь нет ни базы, ни сети: только правила, по которым строка очереди
 * меняет состояние после попытки доставки, и набор каналов уведомления.
 * Сами каналы живут в `src/adapters/notify/*`, разбор очереди —
 * в `src/services/notifications.ts`.
 */
export const NOTIFICATION_CHANNELS = ['inapp', 'webpush', 'whatsapp'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Текст уведомления во всех локалях: язык выбирает читающий, а не отправитель. */
export type LocalizedText = Record<Locale, string>;

/**
 * Чем кончилась попытка доставки.
 *
 * Разница между `retry` и `permanent` — это разница между «сейчас не вышло»
 * и «адресата больше нет»: push-сервис отвечает 410 на снятую подписку,
 * и повторять такую доставку бессмысленно (решение P6-4).
 */
export type DeliveryOutcome =
  | { kind: 'sent' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'retry'; error: string }
  | { kind: 'permanent'; error: string };

/**
 * Сколько раз очередь пробует доставить, прежде чем сдаться.
 *
 * Пауза между попытками — это шаг задания разбора, пять минут: отдельного
 * поля «когда пробовать снова» в модели данных нет, а выдумывать его ради
 * экспоненты значит расширять модель. Пять попыток — это около двадцати
 * минут ожидания, после которых временная помеха уже не временная (P6-4).
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface DeliveryState {
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  error: string | null;
}

export function nextDeliveryState(attempts: number, outcome: DeliveryOutcome): DeliveryState {
  switch (outcome.kind) {
    case 'sent':
      return { status: 'sent', attempts: attempts + 1, error: null };

    /*
     * Пропуск попыткой не считается: канал не подключён или адресату он
     * не нужен — доставки не было вовсе, и счётчик остаётся прежним (P6-5).
     */
    case 'skipped':
      return { status: 'skipped', attempts, error: outcome.reason };

    case 'permanent':
      return { status: 'failed', attempts: attempts + 1, error: outcome.error };

    case 'retry': {
      const used = attempts + 1;

      return {
        status: used >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'queued',
        attempts: used,
        error: outcome.error,
      };
    }
  }
}

export interface ChannelOptions {
  /** У адресата есть живая подписка браузера на push. */
  hasPushSubscription: boolean;
}

/**
 * Каналы по умолчанию.
 *
 * В приложении уведомление есть всегда: это и есть тот самый факт
 * «человеку сообщили», и он не зависит от того, дошёл ли push. Push
 * добавляется только при живой подписке — иначе очередь копила бы строки,
 * которые некому доставить. WhatsApp в набор по умолчанию не входит:
 * канал не подключён, и ставить в очередь заведомо пропускаемое незачем (P6-7).
 */
export function channelsFor(options: ChannelOptions): NotificationChannel[] {
  return options.hasPushSubscription ? ['inapp', 'webpush'] : ['inapp'];
}

/**
 * Каких локалей не хватает тексту. Пустая строка — это отсутствие текста:
 * жилец с казахской локалью увидел бы пустое уведомление и не понял, что
 * ему сообщили.
 */
export function missingLocales(text: Partial<Record<Locale, string>>): Locale[] {
  return LOCALES.filter((locale) => (text[locale] ?? '').trim() === '');
}
