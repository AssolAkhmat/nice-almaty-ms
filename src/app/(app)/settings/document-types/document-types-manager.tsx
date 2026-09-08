'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { StatusPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Table, type TableColumn } from '@/components/ui/table';

import {
  archiveDocumentTypeAction,
  createDocumentTypeAction,
  updateDocumentTypeAction,
  type DocumentTypeActionState,
} from './actions';

export interface DocumentTypeRow {
  id: string;
  code: string;
  nameRu: string;
  nameKk: string;
  nameEn: string;
  validityMonths: number | null;
  requiresIssueDate: boolean;
  isRequired: boolean;
  sortOrder: number;
  isArchived: boolean;
}

const INITIAL: DocumentTypeActionState = {};

export function DocumentTypesManager({
  rows,
  canManage,
}: {
  rows: readonly DocumentTypeRow[];
  canManage: boolean;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState<DocumentTypeRow | null>(null);
  const [pendingArchive, setPendingArchive] = useState<DocumentTypeRow | null>(null);

  const [createState, createAction, isCreatePending] = useActionState(
    createDocumentTypeAction,
    INITIAL,
  );
  const [updateState, updateAction, isUpdatePending] = useActionState(
    updateDocumentTypeAction,
    INITIAL,
  );
  const [archiveState, archiveAction, isArchivePending] = useActionState(
    archiveDocumentTypeAction,
    INITIAL,
  );

  const columns: TableColumn<DocumentTypeRow>[] = [
    { key: 'name', header: t('documentTypes.columns.name'), cell: (row) => row.nameRu },
    {
      key: 'code',
      header: t('documentTypes.columns.code'),
      cell: (row) => <span className="tabular text-text-muted">{row.code}</span>,
    },
    {
      key: 'validity',
      header: t('documentTypes.columns.validity'),
      cell: (row) =>
        row.validityMonths === null
          ? t('documentTypes.values.forever')
          : t('documentTypes.values.months', { count: row.validityMonths }),
    },
    {
      key: 'issueDate',
      header: t('documentTypes.columns.issueDate'),
      cell: (row) =>
        t(row.requiresIssueDate ? 'documentTypes.values.yes' : 'documentTypes.values.no'),
    },
    {
      key: 'required',
      header: t('documentTypes.columns.required'),
      cell: (row) => t(row.isRequired ? 'documentTypes.values.yes' : 'documentTypes.values.no'),
    },
    {
      key: 'status',
      header: t('documentTypes.columns.status'),
      cell: (row) => (
        <StatusPill kind={row.isArchived ? 'muted' : 'done'}>
          {t(row.isArchived ? 'documentTypes.statuses.archived' : 'documentTypes.statuses.active')}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: t('documentTypes.columns.actions'),
      cell: (row) =>
        canManage && !row.isArchived ? (
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid={`edit-${row.code}`}
              onClick={() => {
                setEditing(row);
              }}
              size="sm"
              variant="secondary"
            >
              {t('documentTypes.actions.edit')}
            </Button>
            <Button
              data-testid={`archive-${row.code}`}
              onClick={() => {
                setPendingArchive(row);
              }}
              size="sm"
              variant="danger"
            >
              {t('documentTypes.actions.archive')}
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {[createState, updateState, archiveState].map((state, index) => (
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
            <CardTitle>{t('documentTypes.create.title')}</CardTitle>
          </CardHeader>

          <form action={createAction} className="flex flex-col gap-3" data-testid="create-type">
            <Field
              hint={t('documentTypes.create.codeHint')}
              htmlFor="new-code"
              label={t('documentTypes.columns.code')}
            >
              <Input data-testid="new-type-code" id="new-code" name="code" required />
            </Field>
            <DocumentTypeFields idPrefix="new" />
            <Button data-testid="create-type-submit" disabled={isCreatePending} type="submit">
              {isCreatePending ? t('common.loading') : t('documentTypes.create.submit')}
            </Button>
          </form>
        </Card>
      ) : null}

      <Table
        caption={t('documentTypes.title')}
        columns={columns}
        emptyState={<EmptyState title={t('documentTypes.empty')} />}
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
        title={t('documentTypes.edit.title', { name: editing?.nameRu ?? '' })}
      >
        <form
          action={(formData) => {
            setEditing(null);
            updateAction(formData);
          }}
          className="flex flex-col gap-3"
        >
          <input name="documentTypeId" type="hidden" value={editing?.id ?? ''} />
          <DocumentTypeFields idPrefix="edit" key={editing?.id ?? 'none'} value={editing} />
          <Button data-testid="edit-type-submit" disabled={isUpdatePending} type="submit">
            {t('documentTypes.edit.submit')}
          </Button>
        </form>
      </Modal>

      <Modal
        description={t('documentTypes.archiveConfirm.description')}
        footer={
          <form
            action={(formData) => {
              setPendingArchive(null);
              archiveAction(formData);
            }}
          >
            <input name="documentTypeId" type="hidden" value={pendingArchive?.id ?? ''} />
            <Button disabled={isArchivePending} type="submit" variant="danger">
              {t('documentTypes.actions.archive')}
            </Button>
          </form>
        }
        onOpenChange={(open) => {
          if (!open) {
            setPendingArchive(null);
          }
        }}
        open={pendingArchive !== null}
        title={t('documentTypes.archiveConfirm.title', { name: pendingArchive?.nameRu ?? '' })}
      />
    </div>
  );
}

function DocumentTypeFields({
  idPrefix,
  value,
}: {
  idPrefix: string;
  value?: DocumentTypeRow | null;
}) {
  const t = useTranslations();

  return (
    <>
      <Field htmlFor={`${idPrefix}-name-ru`} label={t('documentTypes.fields.nameRu')}>
        <Input
          data-testid={`${idPrefix}-type-name-ru`}
          defaultValue={value?.nameRu ?? ''}
          id={`${idPrefix}-name-ru`}
          name="nameRu"
          required
        />
      </Field>

      <Field htmlFor={`${idPrefix}-name-kk`} label={t('documentTypes.fields.nameKk')}>
        <Input
          defaultValue={value?.nameKk ?? ''}
          id={`${idPrefix}-name-kk`}
          name="nameKk"
          required
        />
      </Field>

      <Field htmlFor={`${idPrefix}-name-en`} label={t('documentTypes.fields.nameEn')}>
        <Input
          defaultValue={value?.nameEn ?? ''}
          id={`${idPrefix}-name-en`}
          name="nameEn"
          required
        />
      </Field>

      <Field
        hint={t('documentTypes.create.validityHint')}
        htmlFor={`${idPrefix}-validity`}
        label={t('documentTypes.columns.validity')}
      >
        <Input
          className="tabular"
          defaultValue={value?.validityMonths === null ? '' : String(value?.validityMonths ?? '')}
          id={`${idPrefix}-validity`}
          inputMode="numeric"
          max={120}
          min={1}
          name="validityMonths"
          step={1}
          type="number"
        />
      </Field>

      <Field htmlFor={`${idPrefix}-order`} label={t('documentTypes.columns.order')}>
        <Input
          className="tabular"
          defaultValue={String(value?.sortOrder ?? 0)}
          id={`${idPrefix}-order`}
          inputMode="numeric"
          min={0}
          name="sortOrder"
          step={10}
          type="number"
        />
      </Field>

      <label className="flex items-center gap-3 text-[15px]">
        <Checkbox
          defaultChecked={value?.requiresIssueDate ?? false}
          name="requiresIssueDate"
          value="on"
        />
        {t('documentTypes.fields.requiresIssueDate')}
      </label>

      <label className="flex items-center gap-3 text-[15px]">
        <Checkbox defaultChecked={value?.isRequired ?? true} name="isRequired" value="on" />
        {t('documentTypes.fields.isRequired')}
      </label>
    </>
  );
}
