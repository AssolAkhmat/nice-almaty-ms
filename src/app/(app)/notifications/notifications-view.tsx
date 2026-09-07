'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';

import { markAllReadAction, markReadAction, type NotificationActionState } from './actions';

const INITIAL: NotificationActionState = {};

/** По двадцать на страницу: список читают сверху вниз, а не листают вглубь. */
const PAGE_SIZE = 20;

export interface NotificationRow {
  notificationId: string;
  /** Ключ словаря, а не код события: точка в коде — разделитель вложенности. */
  typeKey: string;
  title: string;
  body: string;
  createdAt: string;
  isRead: boolean;
}

export interface NotificationsViewProps {
  rows: readonly NotificationRow[];
  unread: number;
  unreadOnly: boolean;
  type: string;
  /** Коды событий для фильтра, уже переведённые в ключи словаря. */
  typeKeys: readonly { value: string; key: string }[];
}

function useRefreshOnDone(state: NotificationActionState): void {
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);
}

function MarkReadButton({ notificationId }: { notificationId: string }) {
  const t = useTranslations('notifications');
  const [state, action, pending] = useActionState(markReadAction, INITIAL);

  useRefreshOnDone(state);

  return (
    <form action={action}>
      <input name="notificationId" type="hidden" value={notificationId} />
      <Button disabled={pending} size="sm" type="submit" variant="secondary">
        {t('markRead')}
      </Button>
    </form>
  );
}

export function NotificationsView({
  rows,
  type,
  typeKeys,
  unread,
  unreadOnly,
}: NotificationsViewProps) {
  const t = useTranslations('notifications');
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [allState, markAll, markingAll] = useActionState(markAllReadAction, INITIAL);

  useRefreshOnDone(allState);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const visible = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  /** Фильтры живут в адресе: ссылка на непрочитанное должна открываться. */
  const go = (next: { unread?: boolean; type?: string }): void => {
    const params = new URLSearchParams();
    const wantUnread = next.unread ?? unreadOnly;
    const wantType = next.type ?? type;

    if (wantUnread) {
      params.set('unread', '1');
    }

    if (wantType !== '') {
      params.set('type', wantType);
    }

    const query = params.toString();
    router.push(query === '' ? '/notifications' : `/notifications?${query}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <nav className="flex gap-2 text-[13px]">
            <button
              className={unreadOnly ? 'text-text-muted hover:text-text' : 'text-text font-medium'}
              data-testid="filter-all"
              onClick={() => {
                go({ unread: false });
              }}
              type="button"
            >
              {t('all')}
            </button>
            <button
              className={unreadOnly ? 'text-text font-medium' : 'text-text-muted hover:text-text'}
              data-testid="filter-unread"
              onClick={() => {
                go({ unread: true });
              }}
              type="button"
            >
              {t('unreadOnly')}
            </button>
          </nav>

          <Field label={t('filterType')}>
            <Select
              data-testid="filter-type"
              onChange={(event) => {
                go({ type: event.target.value });
              }}
              value={type}
            >
              <option value="">{t('allTypes')}</option>
              {typeKeys.map((item) => (
                <option key={item.value} value={item.value}>
                  {t(`types.${item.key}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-text-muted text-[13px]" data-testid="unread-count">
            {t('unreadCount', { count: unread })}
          </span>
          <form action={markAll}>
            <Button
              disabled={markingAll || unread === 0}
              size="sm"
              type="submit"
              variant="secondary"
            >
              {t('markAllRead')}
            </Button>
          </form>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState title={unreadOnly ? t('emptyUnread') : t('empty')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((row) => (
            <li key={row.notificationId}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={row.isRead ? 'neutral' : 'accent'}>
                        {t(`types.${row.typeKey}`)}
                      </Badge>
                      <span className="tabular text-text-muted text-[13px]">{row.createdAt}</span>
                    </div>
                    <p className="text-[15px] font-medium">{row.title}</p>
                    <p className="text-text-muted text-[13px]">{row.body}</p>
                  </div>

                  {!row.isRead && <MarkReadButton notificationId={row.notificationId} />}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Pagination onPageChange={setPage} page={current} pageCount={pageCount} />
    </div>
  );
}
