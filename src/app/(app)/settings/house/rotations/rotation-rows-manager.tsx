'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';

import { archiveRowAction, saveRowAction, type RotationSetupActionState } from './actions';

const INITIAL: RotationSetupActionState = {};

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export interface BedOption {
  bedId: string;
  label: string;
  areaId: string;
  areaName: string;
}

export interface ZoneOption {
  areaId: string;
  areaName: string;
  areaType: 'living' | 'common';
  checklistId: string;
  checklistTitle: string;
  peopleNeeded: number;
}

/** Жилая комната дома: её выбирает комнатный ряд (§6.4). */
export interface RoomOption {
  areaId: string;
  areaName: string;
}

export interface RowBlock {
  rowId: string;
  name: string;
  type: 'common' | 'room';
  weekday: number;
  startDate: string;
  roomAreaId: string | null;
}

export interface RotationRowsProps {
  houseId: string;
  rows: readonly RowBlock[];
  rooms: readonly RoomOption[];
}

function Message({ state }: { state: RotationSetupActionState }) {
  const t = useTranslations();

  return (
    <>
      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      )}
      {state.done !== undefined && <p className="text-success text-[13px]">{t(state.done)}</p>}
    </>
  );
}

/** Обновление экрана после удачного действия — см. `rotation-setup-manager`. */
function useRefreshOnDone(state: RotationSetupActionState): void {
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);
}

/**
 * Ряд ротаций: имя, тип, день недели и дата первой ротации; у комнатного —
 * комната. Кто участвует и какие зоны убираются, задаётся ниже, в блоке
 * составов и норм дней (план фазы 10 §2.2, §2.3).
 */
function RowForm({
  houseId,
  rooms,
  row,
}: {
  houseId: string;
  rooms: readonly RoomOption[];
  row: RowBlock | null;
}) {
  const t = useTranslations('rotationRows');
  const [saveState, save, isSaving] = useActionState(saveRowAction, INITIAL);
  const [archiveState, archive, isArchiving] = useActionState(archiveRowAction, INITIAL);
  const [type, setType] = useState(row?.type ?? 'common');

  useRefreshOnDone(saveState);
  useRefreshOnDone(archiveState);

  const id = row?.rowId ?? 'new';

  return (
    <div className="flex flex-col gap-2">
      <form action={save} className="flex flex-col gap-3" data-testid={`row-form-${id}`}>
        <input name="houseId" type="hidden" value={houseId} />
        <input name="rowId" type="hidden" value={row?.rowId ?? ''} />

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[160px] flex-1">
            <Field htmlFor={`row-name-${id}`} label={t('name')}>
              <Input
                data-testid={`row-name-${id}`}
                defaultValue={row?.name ?? ''}
                id={`row-name-${id}`}
                name="name"
                required
              />
            </Field>
          </div>

          <div className="w-40">
            <Field htmlFor={`row-type-${id}`} label={t('type')}>
              <Select
                data-testid={`row-type-${id}`}
                id={`row-type-${id}`}
                name="type"
                onChange={(event) => {
                  setType(event.target.value === 'room' ? 'room' : 'common');
                }}
                value={type}
              >
                <option value="common">{t('types.common')}</option>
                <option value="room">{t('types.room')}</option>
              </Select>
            </Field>
          </div>

          <div className="w-40">
            <Field htmlFor={`row-weekday-${id}`} label={t('weekday')}>
              <Select
                data-testid={`row-weekday-${id}`}
                defaultValue={String(row?.weekday ?? 1)}
                id={`row-weekday-${id}`}
                name="weekday"
              >
                {WEEKDAYS.map((weekday) => (
                  <option key={weekday} value={weekday}>
                    {t(`weekdays.${String(weekday)}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="w-44">
            <Field hint={t('startDateHint')} htmlFor={`row-start-${id}`} label={t('startDate')}>
              <Input
                data-testid={`row-start-${id}`}
                defaultValue={row?.startDate ?? ''}
                id={`row-start-${id}`}
                name="startDate"
                required
                type="date"
              />
            </Field>
          </div>

          {type === 'room' && (
            <div className="w-56">
              <Field hint={t('roomHint')} htmlFor={`row-room-${id}`} label={t('room')}>
                <Select
                  data-testid={`row-room-${id}`}
                  defaultValue={row?.roomAreaId ?? ''}
                  id={`row-room-${id}`}
                  name="roomAreaId"
                  required
                >
                  <option value="">{t('room')}</option>
                  {rooms.map((room) => (
                    <option key={room.areaId} value={room.areaId}>
                      {room.areaName}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            data-testid={`row-save-${id}`}
            disabled={isSaving}
            size="sm"
            type="submit"
            variant={row === null ? 'primary' : 'secondary'}
          >
            {row === null ? t('addRow') : t('save')}
          </Button>
        </div>

        <Message state={saveState} />
      </form>

      {/* Выключение ряда — своя форма: вложенных форм в разметке не бывает,
          а обязательные поля соседней не должны мешать его выключить. */}
      {row !== null && (
        <form action={archive}>
          <input name="rowId" type="hidden" value={row.rowId} />
          <Button
            data-testid={`row-archive-${id}`}
            disabled={isArchiving}
            size="sm"
            type="submit"
            variant="ghost"
          >
            {t('archiveRow')}
          </Button>
          <Message state={archiveState} />
        </form>
      )}
    </div>
  );
}

export function RotationRowsManager({ houseId, rooms, rows }: RotationRowsProps) {
  const t = useTranslations('rotationRows');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <p className="text-text-muted mb-4 text-[13px]">{t('hint')}</p>

      <div className="flex flex-col gap-6">
        {rows.map((row) => (
          <RowForm houseId={houseId} key={row.rowId} rooms={rooms} row={row} />
        ))}

        <div className="border-border border-t pt-4">
          <p className="text-text-muted mb-2 text-[13px]">{t('addRowTitle')}</p>
          <RowForm houseId={houseId} rooms={rooms} row={null} />
        </div>
      </div>
    </Card>
  );
}
