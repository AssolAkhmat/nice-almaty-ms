'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { StatusPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Money } from '@/components/ui/money';
import { Table, type TableColumn } from '@/components/ui/table';

import {
  archiveAccountAction,
  createAccountAction,
  renameAccountAction,
  type AccountActionState,
} from './actions';

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  houseName: string | null;
  isSystem: boolean;
  isArchived: boolean;
  balance: number;
}

const INITIAL: AccountActionState = {};

const CREATABLE_TYPES = ['cash', 'kaspi', 'common_fund'] as const;

export function AccountsManager({
  rows,
  canManage,
}: {
  rows: readonly AccountRow[];
  canManage: boolean;
}) {
  const t = useTranslations();
  const [renaming, setRenaming] = useState<AccountRow | null>(null);
  const [pendingArchive, setPendingArchive] = useState<AccountRow | null>(null);

  const [createState, createAction, isCreatePending] = useActionState(createAccountAction, INITIAL);
  const [renameState, renameAction, isRenamePending] = useActionState(renameAccountAction, INITIAL);
  const [archiveState, archiveAction, isArchivePending] = useActionState(
    archiveAccountAction,
    INITIAL,
  );

  const columns: TableColumn<AccountRow>[] = [
    { key: 'name', header: t('chartOfAccounts.columns.name'), cell: (row) => row.name },
    {
      key: 'code',
      header: t('chartOfAccounts.columns.code'),
      cell: (row) => <span className="tabular text-text-muted">{row.code}</span>,
    },
    {
      key: 'type',
      header: t('chartOfAccounts.columns.type'),
      cell: (row) => t(`chartOfAccounts.types.${row.type}`),
    },
    {
      key: 'house',
      header: t('chartOfAccounts.columns.house'),
      cell: (row) => row.houseName ?? t('chartOfAccounts.values.network'),
    },
    {
      key: 'balance',
      header: t('chartOfAccounts.columns.balance'),
      numeric: true,
      cell: (row) => <Money amount={row.balance} />,
    },
    {
      key: 'status',
      header: t('chartOfAccounts.columns.status'),
      cell: (row) => (
        <StatusPill kind={row.isArchived ? 'muted' : 'done'}>
          {t(
            row.isArchived
              ? 'chartOfAccounts.statuses.archived'
              : row.isSystem
                ? 'chartOfAccounts.statuses.system'
                : 'chartOfAccounts.statuses.active',
          )}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: t('chartOfAccounts.columns.actions'),
      cell: (row) =>
        canManage && !row.isArchived ? (
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid={`rename-${row.code}`}
              onClick={() => {
                setRenaming(row);
              }}
              size="sm"
              variant="secondary"
            >
              {t('chartOfAccounts.actions.rename')}
            </Button>
            {row.isSystem ? null : (
              <Button
                data-testid={`archive-account-${row.code}`}
                onClick={() => {
                  setPendingArchive(row);
                }}
                size="sm"
                variant="danger"
              >
                {t('chartOfAccounts.actions.archive')}
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {[createState, renameState, archiveState].map((state, index) => (
        <div key={index}>
          {state.done !== undefined ? (
            <p className="text-success text-[13px]" role="status">
              {t(state.done)}
            </p>
          ) : null}
          {state.error !== undefined ? (
            <p className="text-danger text-[13px]" role="alert">
              {t(state.error)}
            </p>
          ) : null}
        </div>
      ))}

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('chartOfAccounts.create.title')}</CardTitle>
          </CardHeader>

          <form action={createAction} className="flex flex-col gap-3" data-testid="create-account">
            <Field
              hint={t('chartOfAccounts.create.codeHint')}
              htmlFor="new-account-code"
              label={t('chartOfAccounts.columns.code')}
            >
              <Input data-testid="new-account-code" id="new-account-code" name="code" required />
            </Field>

            <Field htmlFor="new-account-name" label={t('chartOfAccounts.columns.name')}>
              <Input data-testid="new-account-name" id="new-account-name" name="name" required />
            </Field>

            <Field htmlFor="new-account-type" label={t('chartOfAccounts.columns.type')}>
              <Select data-testid="new-account-type" id="new-account-type" name="type">
                {CREATABLE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`chartOfAccounts.types.${type}`)}
                  </option>
                ))}
              </Select>
            </Field>

            <Button data-testid="create-account-submit" disabled={isCreatePending} type="submit">
              {isCreatePending ? t('common.loading') : t('chartOfAccounts.create.submit')}
            </Button>
          </form>
        </Card>
      ) : null}

      <Table
        caption={t('chartOfAccounts.title')}
        columns={columns}
        emptyState={<EmptyState title={t('chartOfAccounts.empty')} />}
        rowKey={(row) => row.id}
        rows={rows}
      />

      <Modal
        onOpenChange={(open) => {
          if (!open) {
            setRenaming(null);
          }
        }}
        open={renaming !== null}
        title={t('chartOfAccounts.rename.title', { name: renaming?.name ?? '' })}
      >
        <form
          action={(formData) => {
            setRenaming(null);
            renameAction(formData);
          }}
          className="flex flex-col gap-3"
        >
          <input name="accountId" type="hidden" value={renaming?.id ?? ''} />
          <Field htmlFor="rename-account-name" label={t('chartOfAccounts.columns.name')}>
            <Input
              defaultValue={renaming?.name ?? ''}
              id="rename-account-name"
              key={renaming?.id ?? 'none'}
              name="name"
              required
            />
          </Field>
          <Button data-testid="rename-account-submit" disabled={isRenamePending} type="submit">
            {t('chartOfAccounts.rename.submit')}
          </Button>
        </form>
      </Modal>

      <Modal
        description={t('chartOfAccounts.archiveConfirm.description')}
        footer={
          <form
            action={(formData) => {
              setPendingArchive(null);
              archiveAction(formData);
            }}
          >
            <input name="accountId" type="hidden" value={pendingArchive?.id ?? ''} />
            <Button disabled={isArchivePending} type="submit" variant="danger">
              {t('chartOfAccounts.actions.archive')}
            </Button>
          </form>
        }
        onOpenChange={(open) => {
          if (!open) {
            setPendingArchive(null);
          }
        }}
        open={pendingArchive !== null}
        title={t('chartOfAccounts.archiveConfirm.title', { name: pendingArchive?.name ?? '' })}
      />
    </div>
  );
}
