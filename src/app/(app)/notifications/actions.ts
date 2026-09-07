'use server';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { listInbox, markRead } from '@/services/notifications';

/**
 * Центр уведомлений (docs/02-DATA-MODEL.md, «Файлы, уведомления, система»).
 *
 * Читать и отмечать прочитанным вправе только адресат: проверка живёт
 * в сервисе, экран её не дублирует и не обходит.
 */
export interface NotificationActionState {
  error?: string;
  done?: string;
}

function failure(error: unknown): NotificationActionState {
  return { error: error instanceof AppError ? error.message : 'notifications.errors.unknown' };
}

export async function markReadAction(
  _state: NotificationActionState,
  formData: FormData,
): Promise<NotificationActionState> {
  const session = await getCurrentSession();

  if (session === null) {
    return { error: 'notifications.errors.unknown' };
  }

  const notificationId = formData.get('notificationId');

  if (typeof notificationId !== 'string' || notificationId === '') {
    return { error: 'notifications.errors.unknown' };
  }

  try {
    await markRead(session.context, notificationId);

    return { done: 'notifications.markRead' };
  } catch (error) {
    return failure(error);
  }
}

/**
 * «Прочитать все» отмечает то, что человек сейчас видит, — непрочитанное
 * на этот момент. Уведомление, пришедшее в ту же секунду, останется
 * непрочитанным: он его не читал.
 */
export async function markAllReadAction(
  _state: NotificationActionState,
): Promise<NotificationActionState> {
  const session = await getCurrentSession();

  if (session === null) {
    return { error: 'notifications.errors.unknown' };
  }

  try {
    const unread = await listInbox(session.context, { unreadOnly: true });

    for (const notification of unread) {
      await markRead(session.context, notification.id);
    }

    return { done: 'notifications.markAllRead' };
  } catch (error) {
    return failure(error);
  }
}
