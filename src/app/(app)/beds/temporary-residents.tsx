'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';

import {
  addTemporaryAction,
  editTemporaryAction,
  removeTemporaryAction,
  type TemporaryActionState,
} from './actions';

/**
 * Временные жильцы для ротаций (T11.3, решение D23).
 *
 * Заводятся здесь, а не в списке жильцов: временный жилец — это имя на месте,
 * а не учётная запись. Входа, профиля, документов, депозита и рейтинга у него
 * нет и не будет; он существует затем, чтобы ряд ротаций был полным.
 *
 * Пол обязателен. Без него не работают предустановленные фильтры допуска
 * «парни» и «девушки»: проверка там строгая, и пустое значение не проходит
 * ни в одну группу. Комнату даёт само место.
 */
export interface TemporaryRowView {
  id: string;
  name: string;
  sex: 'male' | 'female';
  bedLabel: string;
  areaName: string;
  from: string;
  to: string | null;
  note: string | null;
}

export interface TemporaryBedOption {
  bedId: string;
  label: string;
}

const INITIAL: TemporaryActionState = {};

function SexField({ value }: { value?: 'male' | 'female' }) {
  const t = useTranslations('temporaryResidents');

  return (
    <Field htmlFor="temporary-sex" label={t('sex')}>
      <Select defaultValue={value ?? ''} id="temporary-sex" name="sex" required>
        <option value="">—</option>
        <option value="male">{t('male')}</option>
        <option value="female">{t('female')}</option>
      </Select>
    </Field>
  );
}

function AddForm({
  beds,
  houseId,
  today,
}: {
  beds: readonly TemporaryBedOption[];
  houseId: string;
  today: string;
}) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(addTemporaryAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-3" data-testid="temporary-add">
      <input name="houseId" type="hidden" value={houseId} />

      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-5">
        <Field htmlFor="temporary-name" label={t('temporaryResidents.name')}>
          <Input data-testid="temporary-name" id="temporary-name" name="name" required />
        </Field>

        <SexField />

        <Field htmlFor="temporary-bed" label={t('beds.bed')}>
          <Select data-testid="temporary-bed" id="temporary-bed" name="bedId" required>
            {beds.map((bed) => (
              <option key={bed.bedId} value={bed.bedId}>
                {bed.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field htmlFor="temporary-from" label={t('temporaryResidents.from')}>
          <Input defaultValue={today} id="temporary-from" name="from" required type="date" />
        </Field>

        <Field
          hint={t('temporaryResidents.open')}
          htmlFor="temporary-to"
          label={t('temporaryResidents.to')}
        >
          <Input id="temporary-to" name="to" type="date" />
        </Field>
      </div>

      <Field htmlFor="temporary-note" label={t('temporaryResidents.note')}>
        <Input id="temporary-note" name="note" />
      </Field>

      <Button className="md:w-fit" disabled={isPending} size="sm" type="submit">
        {t('temporaryResidents.add')}
      </Button>
    </form>
  );
}

function Row({ row }: { row: TemporaryRowView }) {
  const t = useTranslations();
  const [editState, editAction, isSaving] = useActionState(editTemporaryAction, INITIAL);
  const [removeState, removeAction, isRemoving] = useActionState(removeTemporaryAction, INITIAL);
  const [isEditing, setEditing] = useState(false);

  if (isEditing) {
    return (
      <li className="border-border flex flex-col gap-3 border-t py-3">
        <form action={editAction} className="flex flex-col gap-3">
          <input name="id" type="hidden" value={row.id} />

          {editState.error !== undefined && (
            <p className="text-danger text-[13px]" role="alert">
              {t(editState.error)}
            </p>
          )}

          <div className="grid gap-3 md:grid-cols-4">
            <Field htmlFor="temporary-name" label={t('temporaryResidents.name')}>
              <Input defaultValue={row.name} id="temporary-name" name="name" required />
            </Field>

            <SexField value={row.sex} />

            <Field htmlFor="temporary-from" label={t('temporaryResidents.from')}>
              <Input defaultValue={row.from} id="temporary-from" name="from" required type="date" />
            </Field>

            <Field htmlFor="temporary-to" label={t('temporaryResidents.to')}>
              <Input defaultValue={row.to ?? ''} id="temporary-to" name="to" type="date" />
            </Field>
          </div>

          <Field htmlFor="temporary-note" label={t('temporaryResidents.note')}>
            <Input defaultValue={row.note ?? ''} id="temporary-note" name="note" />
          </Field>

          <div className="flex gap-2">
            <Button disabled={isSaving} size="sm" type="submit">
              {t('temporaryResidents.save')}
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t('common.close')}
            </Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li
      className="border-border flex flex-wrap items-center justify-between gap-3 border-t py-2 text-[13px]"
      data-testid="temporary-row"
    >
      <span className="flex flex-wrap items-center gap-2">
        <b>{row.name}</b>
        <span className="text-text-muted">{t(`temporaryResidents.${row.sex}`)}</span>
        <span className="text-text-muted">
          {row.areaName}, {row.bedLabel}
        </span>
        <span className="text-text-muted">
          {row.from} — {row.to ?? t('temporaryResidents.open')}
        </span>
        {row.note !== null && <span className="text-text-muted">{row.note}</span>}
      </span>

      <span className="flex items-center gap-2">
        {removeState.error !== undefined && (
          <span className="text-danger" role="alert">
            {t(removeState.error)}
          </span>
        )}

        <Button
          data-testid="temporary-edit"
          onClick={() => {
            setEditing(true);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t('temporaryResidents.edit')}
        </Button>

        <form action={removeAction}>
          <input name="id" type="hidden" value={row.id} />
          <Button disabled={isRemoving} size="sm" type="submit" variant="ghost">
            {t('temporaryResidents.remove')}
          </Button>
        </form>
      </span>
    </li>
  );
}

export function TemporaryResidents({
  rows,
  beds,
  houseId,
  today,
  canWrite,
}: {
  rows: readonly TemporaryRowView[];
  beds: readonly TemporaryBedOption[];
  houseId: string;
  today: string;
  canWrite: boolean;
}) {
  const t = useTranslations('temporaryResidents');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0">
        {rows.length === 0 ? (
          <p className="text-text-muted text-[13px]">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </ul>
        )}

        {canWrite && beds.length > 0 && <AddForm beds={beds} houseId={houseId} today={today} />}
      </div>
    </Card>
  );
}
