'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { StatusPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Table, type TableColumn } from '@/components/ui/table';
import { PROFILE_FIELD_TYPES, type ProfileFieldType } from '@/domain/profile-fields';

import {
  archiveFieldAction,
  declareFieldAction,
  updateFieldAction,
  type ProfileFieldActionState,
} from './actions';

export interface ProfileFieldRow {
  id: string;
  code: string;
  nameRu: string;
  nameKk: string;
  nameEn: string;
  type: ProfileFieldType;
  isRequired: boolean;
  options: string[];
  sortOrder: number;
  isArchived: boolean;
  /** Есть ли токен этого поля в действующем шаблоне договора. */
  usedInTemplate: boolean;
}

const INITIAL: ProfileFieldActionState = {};

/**
 * Объявление дополнительных полей профиля (T12.3).
 *
 * Кнопки удаления здесь нет и не будет: на поле ссылаются подписанные
 * договоры и карточки жильцов, а удаление стёрло бы смысл чужого документа.
 * Архивация убирает поле из формы и оставляет историю читаемой.
 *
 * Код и тип у заведённого поля не меняются: по коду собран договор, а сменой
 * типа прежние значения перестали бы разбираться. Поэтому в правке их нет.
 */
export function ProfileFieldsManager({
  rows,
  canManage,
}: {
  rows: readonly ProfileFieldRow[];
  canManage: boolean;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState<ProfileFieldRow | null>(null);
  const [pendingArchive, setPendingArchive] = useState<ProfileFieldRow | null>(null);

  const [createState, createAction, isCreatePending] = useActionState(declareFieldAction, INITIAL);
  const [updateState, updateAction, isUpdatePending] = useActionState(updateFieldAction, INITIAL);
  const [archiveState, archiveAction, isArchivePending] = useActionState(
    archiveFieldAction,
    INITIAL,
  );

  const columns: TableColumn<ProfileFieldRow>[] = [
    { key: 'name', header: t('profileFields.columns.name'), cell: (row) => row.nameRu },
    {
      key: 'token',
      header: t('profileFields.columns.token'),
      cell: (row) => <span className="tabular text-text-muted">{`profile.${row.code}`}</span>,
    },
    {
      key: 'type',
      header: t('profileFields.columns.type'),
      cell: (row) => t(`profileFields.types.${row.type}`),
    },
    {
      key: 'required',
      header: t('profileFields.columns.required'),
      cell: (row) => t(row.isRequired ? 'profileFields.values.yes' : 'profileFields.values.no'),
    },
    {
      key: 'status',
      header: t('profileFields.columns.status'),
      cell: (row) => (
        <StatusPill kind={row.isArchived ? 'muted' : 'done'}>
          {t(row.isArchived ? 'profileFields.statuses.archived' : 'profileFields.statuses.active')}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: t('profileFields.columns.actions'),
      cell: (row) =>
        canManage ? (
          <div className="flex flex-wrap gap-2">
            {row.isArchived ? (
              <form
                action={archiveAction}
                className="inline"
                data-testid={`restore-${row.code}-form`}
              >
                <input name="fieldId" type="hidden" value={row.id} />
                <input name="archived" type="hidden" value="false" />
                <Button
                  data-testid={`restore-${row.code}`}
                  disabled={isArchivePending}
                  size="sm"
                  type="submit"
                  variant="secondary"
                >
                  {t('profileFields.actions.restore')}
                </Button>
              </form>
            ) : (
              <>
                <Button
                  data-testid={`edit-${row.code}`}
                  onClick={() => {
                    setEditing(row);
                  }}
                  size="sm"
                  variant="secondary"
                >
                  {t('profileFields.actions.edit')}
                </Button>
                <Button
                  data-testid={`archive-${row.code}`}
                  onClick={() => {
                    setPendingArchive(row);
                  }}
                  size="sm"
                  variant="danger"
                >
                  {t('profileFields.actions.archive')}
                </Button>
              </>
            )}
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
            <p className="text-danger text-[13px]" data-testid="profile-field-error" role="alert">
              {t(state.error, state.errorParams)}
            </p>
          ) : null}
        </div>
      ))}

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('profileFields.create.title')}</CardTitle>
          </CardHeader>

          <form action={createAction} className="flex flex-col gap-3" data-testid="create-field">
            <Field
              hint={t('profileFields.create.codeHint')}
              htmlFor="new-code"
              label={t('profileFields.columns.code')}
            >
              <Input data-testid="new-field-code" id="new-code" name="code" required />
            </Field>

            <Field htmlFor="new-type" label={t('profileFields.columns.type')}>
              <Select data-testid="new-field-type" defaultValue="text" id="new-type" name="type">
                {PROFILE_FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`profileFields.types.${type}`)}
                  </option>
                ))}
              </Select>
            </Field>

            <ProfileFieldInputs idPrefix="new" />

            <Button data-testid="create-field-submit" disabled={isCreatePending} type="submit">
              {isCreatePending ? t('common.loading') : t('profileFields.create.submit')}
            </Button>
          </form>
        </Card>
      ) : null}

      <Table
        caption={t('profileFields.title')}
        columns={columns}
        emptyState={<EmptyState title={t('profileFields.empty')} />}
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
        title={t('profileFields.edit.title', { name: editing?.nameRu ?? '' })}
      >
        <form
          action={(formData) => {
            setEditing(null);
            updateAction(formData);
          }}
          className="flex flex-col gap-3"
        >
          <input name="fieldId" type="hidden" value={editing?.id ?? ''} />
          <ProfileFieldInputs idPrefix="edit" key={editing?.id ?? 'none'} value={editing} />
          <Button data-testid="edit-field-submit" disabled={isUpdatePending} type="submit">
            {t('profileFields.edit.submit')}
          </Button>
        </form>
      </Modal>

      <Modal
        description={
          pendingArchive?.usedInTemplate === true
            ? t('profileFields.archiveConfirm.inTemplate')
            : t('profileFields.archiveConfirm.description')
        }
        footer={
          <form
            action={(formData) => {
              setPendingArchive(null);
              archiveAction(formData);
            }}
          >
            <input name="fieldId" type="hidden" value={pendingArchive?.id ?? ''} />
            <input name="archived" type="hidden" value="true" />
            <Button
              data-testid="archive-field-submit"
              disabled={isArchivePending}
              type="submit"
              variant="danger"
            >
              {t('profileFields.actions.archive')}
            </Button>
          </form>
        }
        onOpenChange={(open) => {
          if (!open) {
            setPendingArchive(null);
          }
        }}
        open={pendingArchive !== null}
        title={t('profileFields.archiveConfirm.title', { name: pendingArchive?.nameRu ?? '' })}
      />
    </div>
  );
}

function ProfileFieldInputs({
  idPrefix,
  value,
}: {
  idPrefix: string;
  value?: ProfileFieldRow | null;
}) {
  const t = useTranslations();

  return (
    <>
      <Field htmlFor={`${idPrefix}-name-ru`} label={t('profileFields.fields.nameRu')}>
        <Input
          data-testid={`${idPrefix}-field-name-ru`}
          defaultValue={value?.nameRu ?? ''}
          id={`${idPrefix}-name-ru`}
          name="nameRu"
          required
        />
      </Field>

      <Field htmlFor={`${idPrefix}-name-kk`} label={t('profileFields.fields.nameKk')}>
        <Input
          defaultValue={value?.nameKk ?? ''}
          id={`${idPrefix}-name-kk`}
          name="nameKk"
          required
        />
      </Field>

      <Field htmlFor={`${idPrefix}-name-en`} label={t('profileFields.fields.nameEn')}>
        <Input
          defaultValue={value?.nameEn ?? ''}
          id={`${idPrefix}-name-en`}
          name="nameEn"
          required
        />
      </Field>

      <Field
        hint={t('profileFields.fields.optionsHint')}
        htmlFor={`${idPrefix}-options`}
        label={t('profileFields.fields.options')}
      >
        <Textarea
          data-testid={`${idPrefix}-field-options`}
          defaultValue={(value?.options ?? []).join('\n')}
          id={`${idPrefix}-options`}
          name="options"
          rows={3}
        />
      </Field>

      <Field htmlFor={`${idPrefix}-order`} label={t('profileFields.columns.order')}>
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
          data-testid={`${idPrefix}-field-required`}
          defaultChecked={value?.isRequired ?? false}
          name="isRequired"
          value="on"
        />
        {t('profileFields.fields.isRequired')}
      </label>
    </>
  );
}
