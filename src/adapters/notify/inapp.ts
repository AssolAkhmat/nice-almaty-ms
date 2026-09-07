import type { NotificationSender } from './types';

/**
 * Канал «в приложении».
 *
 * Доставлять здесь нечего: сама запись `notifications` создана при
 * постановке, и она и есть уведомление в приложении. Канал существует,
 * чтобы у этого факта была своя строка очереди со своим статусом —
 * иначе «показано в приложении» и «доставлено на телефон» слились бы
 * в одно, и по журналу было бы не понять, что именно случилось.
 *
 * Счётчик непрочитанного считается по этим же записям
 * (`unreadCount` в `src/services/notifications.ts`).
 */
export const inappSender: NotificationSender = {
  channel: 'inapp',
  deliver: () => Promise.resolve({ kind: 'sent' }),
};
