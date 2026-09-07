import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { NOTIFICATION_TYPES, notificationTypeKey } from '@/domain/notifications';
import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n/config';
import { getCurrentSession } from '@/lib/session';
import { listInbox, unreadCount } from '@/services/notifications';

import { NotificationsView, type NotificationRow } from './notifications-view';

import type { Locale } from '@/lib/i18n/config';

export const dynamic = 'force-dynamic';

/**
 * Центр уведомлений (docs/02-DATA-MODEL.md, «Файлы, уведомления, система»).
 *
 * Уведомление — личное сообщение: человек видит только свои, и права
 * это не расширяют никому (P6-1). Тексты хранятся во всех трёх локалях,
 * а выбирает язык читающий — здесь и сейчас.
 */
const LIST_LIMIT = 100;

function textIn(value: unknown, locale: Locale): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }

  const texts = value as Partial<Record<Locale, string>>;

  return texts[locale] ?? texts[DEFAULT_LOCALE] ?? '';
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ unread?: string; type?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('notifications');
  const { context } = session;

  const params = await searchParams;
  const unreadOnly = params.unread === '1';
  const type = NOTIFICATION_TYPES.includes(
    (params.type ?? '') as (typeof NOTIFICATION_TYPES)[number],
  )
    ? (params.type ?? '')
    : '';

  const rawLocale = await getLocale();
  const locale: Locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const [notifications, unread] = await Promise.all([
    listInbox(
      context,
      { unreadOnly, limit: LIST_LIMIT, ...(type === '' ? {} : { type }) },
      undefined,
    ),
    unreadCount(context),
  ]);

  const rows: NotificationRow[] = notifications.map((notification) => ({
    notificationId: notification.id,
    typeKey: notificationTypeKey(notification.type),
    title: textIn(notification.titleI18n, locale),
    body: textIn(notification.bodyI18n, locale),
    // Дата без времени: точная минута доставки читающему ничего не даёт.
    createdAt: notification.createdAt.toISOString().slice(0, 10),
    isRead: notification.readAt !== null,
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <NotificationsView
        rows={rows}
        type={type}
        typeKeys={NOTIFICATION_TYPES.map((value) => ({
          value,
          key: notificationTypeKey(value),
        }))}
        unread={unread}
        unreadOnly={unreadOnly}
      />
    </section>
  );
}
