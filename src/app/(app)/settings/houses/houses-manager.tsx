'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Money } from '@/components/ui/money';
import { StatusPill } from '@/components/ui/badge';
import { Table, type TableColumn } from '@/components/ui/table';

import {
  archiveHouseAction,
  createHouseAction,
  updateHouseAction,
  type HouseActionState,
} from './actions';

export interface HouseRow {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  curfewTime: string;
  defaultDeposit: number;
  isArchived: boolean;
}

const INITIAL: HouseActionState = {};

export function HousesManager({
  rows,
  canManage,
}: {
  rows: readonly HouseRow[];
  canManage: boolean;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState<HouseRow | null>(null);
  const [pendingArchive, setPendingArchive] = useState<HouseRow | null>(null);

  const [createState, createAction, isCreatePending] = useActionState(createHouseAction, INITIAL);
  const [updateState, updateAction, isUpdatePending] = useActionState(updateHouseAction, INITIAL);
  const [archiveState, archiveAction, isArchivePending] = useActionState(
    archiveHouseAction,
    INITIAL,
  );

  const columns: TableColumn<HouseRow>[] = [
    { key: 'name', header: t('houses.columns.name'), cell: (row) => row.name },
    {
      key: 'slug',
      header: t('houses.columns.slug'),
      cell: (row) => <span className="tabular text-text-muted">{row.slug}</span>,
    },
    { key: 'address', header: t('houses.columns.address'), cell: (row) => row.address ?? '—' },
    {
      key: 'curfew',
      header: t('houses.columns.curfew'),
      cell: (row) => <span className="tabular">{row.curfewTime.slice(0, 5)}</span>,
    },
    {
      key: 'deposit',
      header: t('houses.columns.deposit'),
      numeric: true,
      cell: (row) => <Money amount={row.defaultDeposit} />,
    },
    {
      key: 'status',
      header: t('houses.columns.status'),
      cell: (row) => (
        <StatusPill kind={row.isArchived ? 'muted' : 'done'}>
          {t(row.isArchived ? 'houses.statuses.archived' : 'houses.statuses.active')}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: t('houses.columns.actions'),
      cell: (row) =>
        canManage && !row.isArchived ? (
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid={`edit-${row.slug}`}
              onClick={() => {
                setEditing(row);
              }}
              size="sm"
              variant="secondary"
            >
              {t('houses.actions.edit')}
            </Button>
            <Button
              data-testid={`archive-${row.slug}`}
              onClick={() => {
                setPendingArchive(row);
              }}
              size="sm"
              variant="danger"
            >
              {t('houses.actions.archive')}
            </Button>
          </div>
        ) : null,
    },
  ];

  const messages = [createState, updateState, archiveState];

  return (
    <div className="flex flex-col gap-4">
      {messages.map((state, index) => (
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
            <CardTitle>{t('houses.create.title')}</CardTitle>
          </CardHeader>

          <form action={createAction} className="flex flex-col gap-3" data-testid="create-house">
            <HouseFields idPrefix="new" />
            <Button data-testid="create-house-submit" disabled={isCreatePending} type="submit">
              {isCreatePending ? t('common.loading') : t('houses.create.submit')}
            </Button>
          </form>
        </Card>
      ) : null}

      <Table
        caption={t('houses.title')}
        columns={columns}
        emptyState={<EmptyState title={t('houses.empty')} />}
        rowKey={(row) => row.id}
        rows={rows}
      />

      <Modal
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
          }
        }}
        open={editing !== null}
        title={t('houses.edit.title', { name: editing?.name ?? '' })}
      >
        <form
          action={(formData) => {
            setEditing(null);
            updateAction(formData);
          }}
          className="flex flex-col gap-3"
        >
          <input name="houseId" type="hidden" value={editing?.id ?? ''} />
          <HouseFields idPrefix="edit" key={editing?.id ?? 'none'} value={editing} />
          <Button data-testid="edit-house-submit" disabled={isUpdatePending} type="submit">
            {t('houses.edit.submit')}
          </Button>
        </form>
      </Modal>

      <Modal
        description={t('houses.archiveConfirm.description')}
        onOpenChange={(open) => {
          if (!open) {
            setPendingArchive(null);
          }
        }}
        open={pendingArchive !== null}
        title={t('houses.archiveConfirm.title', { name: pendingArchive?.name ?? '' })}
        footer={
          <form
            action={(formData) => {
              setPendingArchive(null);
              archiveAction(formData);
            }}
          >
            <input name="houseId" type="hidden" value={pendingArchive?.id ?? ''} />
            <Button disabled={isArchivePending} type="submit" variant="danger">
              {t('houses.actions.archive')}
            </Button>
          </form>
        }
      />
    </div>
  );
}

function HouseFields({ idPrefix, value }: { idPrefix: string; value?: HouseRow | null }) {
  const t = useTranslations();

  return (
    <>
      <Field htmlFor={`${idPrefix}-name`} label={t('houses.columns.name')}>
        <Input
          data-testid={`${idPrefix}-house-name`}
          defaultValue={value?.name ?? ''}
          id={`${idPrefix}-name`}
          name="name"
          required
        />
      </Field>

      <Field htmlFor={`${idPrefix}-address`} label={t('houses.columns.address')}>
        <Input defaultValue={value?.address ?? ''} id={`${idPrefix}-address`} name="address" />
      </Field>

      <Field
        hint={t('houses.create.curfewHint')}
        htmlFor={`${idPrefix}-curfew`}
        label={t('houses.columns.curfew')}
      >
        <Input
          defaultValue={value?.curfewTime.slice(0, 5) ?? '23:00'}
          id={`${idPrefix}-curfew`}
          name="curfewTime"
          type="time"
        />
      </Field>

      <Field
        hint={t('houses.create.depositHint')}
        htmlFor={`${idPrefix}-deposit`}
        label={t('houses.columns.deposit')}
      >
        <Input
          className="tabular"
          defaultValue={String(value?.defaultDeposit ?? 45000)}
          id={`${idPrefix}-deposit`}
          inputMode="numeric"
          min={0}
          name="defaultDeposit"
          step={1}
          type="number"
        />
      </Field>
    </>
  );
}
