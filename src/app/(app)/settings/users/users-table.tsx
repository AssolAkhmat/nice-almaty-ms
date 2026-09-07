'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Badge, StatusPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { Table, type TableColumn } from '@/components/ui/table';
import { parseInstant } from '@/lib/time';

import { allowPasswordResetAction, archiveAccountAction, type AccountActionState } from './actions';

export interface AccountRow {
  id: string;
  phone: string;
  role: 'superadmin' | 'admin' | 'resident';
  houseName: string | null;
  status: 'active' | 'archived';
  lastLoginAt: string | null;
  isSelf: boolean;
  canAllowReset: boolean;
  canArchive: boolean;
}

const INITIAL: AccountActionState = {};

/**
 * Сколько записей на странице. Сеть за пару лет набирает сотни аккаунтов,
 * и список целиком перестаёт открываться за разумное время: на шестистах
 * жильцах перерисовка после создания аккаунта переставала укладываться
 * даже в ожидание приёмки (инцидент I3).
 */
const PAGE_SIZE = 25;

export function UsersTable({ rows }: { rows: readonly AccountRow[] }) {
  const t = useTranslations();
  const format = useFormatter();
  const [pendingArchive, setPendingArchive] = useState<AccountRow | null>(null);
  const [page, setPage] = useState(1);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // Список мог укоротиться архивацией: страница за его концом пустой не бывает.
  const current = Math.min(page, pageCount);
  const visible = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const [resetState, resetAction, isResetPending] = useActionState(
    allowPasswordResetAction,
    INITIAL,
  );
  const [archiveState, archiveAction, isArchivePending] = useActionState(
    archiveAccountAction,
    INITIAL,
  );

  const columns: TableColumn<AccountRow>[] = [
    {
      key: 'phone',
      header: t('users.columns.phone'),
      cell: (row) => <span className="tabular">{row.phone}</span>,
    },
    {
      key: 'role',
      header: t('users.columns.role'),
      cell: (row) => <Badge tone="info">{t(`users.roles.${row.role}`)}</Badge>,
    },
    {
      key: 'house',
      header: t('users.columns.house'),
      cell: (row) => row.houseName ?? '—',
    },
    {
      key: 'status',
      header: t('users.columns.status'),
      cell: (row) => (
        <StatusPill kind={row.status === 'active' ? 'done' : 'muted'}>
          {t(`users.statuses.${row.status}`)}
        </StatusPill>
      ),
    },
    {
      key: 'lastLogin',
      header: t('users.columns.lastLogin'),
      cell: (row) =>
        row.lastLoginAt === null ? (
          '—'
        ) : (
          <span className="tabular">
            {format.dateTime(parseInstant(row.lastLoginAt), {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
          </span>
        ),
    },
    {
      key: 'actions',
      header: t('users.columns.actions'),
      cell: (row) => (
        <div className="flex flex-wrap gap-2">
          {row.canAllowReset && row.status === 'active' ? (
            <form action={resetAction}>
              <input name="userId" type="hidden" value={row.id} />
              <Button
                data-testid={`allow-reset-${row.phone}`}
                disabled={isResetPending}
                size="sm"
                type="submit"
                variant="secondary"
              >
                {t('users.actions.allowReset')}
              </Button>
            </form>
          ) : null}

          {row.canArchive && row.status === 'active' && !row.isSelf ? (
            <Button
              data-testid={`archive-${row.phone}`}
              onClick={() => {
                setPendingArchive(row);
              }}
              size="sm"
              variant="danger"
            >
              {t('users.actions.archive')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {resetState.done !== undefined ? (
        <p className="text-success text-[13px]" data-testid="reset-allowed" role="status">
          {t(resetState.done)}
        </p>
      ) : null}
      {resetState.error !== undefined ? (
        <p className="text-danger text-[13px]" role="alert">
          {t(resetState.error)}
        </p>
      ) : null}
      {archiveState.done !== undefined ? (
        <p className="text-success text-[13px]" data-testid="archived" role="status">
          {t(archiveState.done)}
        </p>
      ) : null}
      {archiveState.error !== undefined ? (
        <p className="text-danger text-[13px]" role="alert">
          {t(archiveState.error)}
        </p>
      ) : null}

      <Table
        caption={t('users.title')}
        columns={columns}
        emptyState={<EmptyState title={t('users.empty')} />}
        rowKey={(row) => row.id}
        rows={visible}
      />

      <Pagination onPageChange={setPage} page={current} pageCount={pageCount} />

      {/* Архивация необратима в интерфейсе, поэтому подтверждение с описанием последствий. */}
      <Modal
        description={t('users.archiveConfirm.description')}
        onOpenChange={(open) => {
          if (!open) {
            setPendingArchive(null);
          }
        }}
        open={pendingArchive !== null}
        title={t('users.archiveConfirm.title', { phone: pendingArchive?.phone ?? '' })}
        footer={
          <form
            action={(formData) => {
              setPendingArchive(null);
              archiveAction(formData);
            }}
          >
            <input name="userId" type="hidden" value={pendingArchive?.id ?? ''} />
            <Button
              data-testid="archive-confirm"
              disabled={isArchivePending}
              type="submit"
              variant="danger"
            >
              {t('users.actions.archive')}
            </Button>
          </form>
        }
      />
    </div>
  );
}
