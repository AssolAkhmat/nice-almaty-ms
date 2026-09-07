'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
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

export interface RowBlock {
  rowId: string;
  name: string;
  type: 'common' | 'room';
  weekday: number;
  startDate: string;
  /** Место ряда и его позиция в цикле. */
  slots: { bedId: string; position: number }[];
  zones: { areaId: string; checklistId: string; position: number }[];
}

export interface RotationRowsProps {
  houseId: string;
  rows: readonly RowBlock[];
  beds: readonly BedOption[];
  zones: readonly ZoneOption[];
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
 * Ряд ротаций: расписание и состав.
 *
 * Порядок мест и зон задаётся числом в поле рядом с каждым: это и есть
 * позиция в цикле §6.2. Пустое поле означает, что место или зона в ряд
 * не входят.
 */
function RowForm({
  beds,
  houseId,
  row,
  zones,
}: {
  beds: readonly BedOption[];
  houseId: string;
  row: RowBlock | null;
  zones: readonly ZoneOption[];
}) {
  const t = useTranslations('rotationRows');
  const [saveState, save, isSaving] = useActionState(saveRowAction, INITIAL);
  const [archiveState, archive, isArchiving] = useActionState(archiveRowAction, INITIAL);
  const [type, setType] = useState(row?.type ?? 'common');

  useRefreshOnDone(saveState);
  useRefreshOnDone(archiveState);

  const id = row?.rowId ?? 'new';
  const slotPosition = new Map(row?.slots.map((slot) => [slot.bedId, slot.position]));
  const zonePosition = new Map(
    row?.zones.map((zone) => [`${zone.areaId}|${zone.checklistId}`, zone.position]),
  );

  // Комнатный ряд убирает жилую комнату, обычный — что угодно, кроме неё.
  const zoneOptions = zones.filter((zone) => (type === 'room' ? zone.areaType === 'living' : true));

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
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:gap-6">
          <fieldset className="flex min-w-0 flex-1 flex-col gap-2">
            <legend className="text-text-muted text-[13px]">{t('slots')}</legend>
            {beds.map((bed) => (
              <label
                className="flex items-center justify-between gap-3 text-[13px]"
                key={bed.bedId}
              >
                <span className="truncate">
                  {bed.areaName} · {bed.label}
                </span>
                <Input
                  className="w-20"
                  data-testid={`row-slot-${id}-${bed.bedId}`}
                  defaultValue={slotPosition.get(bed.bedId) ?? ''}
                  min={0}
                  name={`slot-${bed.bedId}`}
                  step={1}
                  type="number"
                />
              </label>
            ))}
          </fieldset>

          <fieldset className="flex min-w-0 flex-1 flex-col gap-2">
            <legend className="text-text-muted text-[13px]">{t('zones')}</legend>
            {zoneOptions.map((zone) => (
              <label
                className="flex items-center justify-between gap-3 text-[13px]"
                key={`${zone.areaId}|${zone.checklistId}`}
              >
                <span className="truncate">
                  {zone.areaName} · {zone.checklistTitle}
                  <Badge tone="neutral">{zone.peopleNeeded}</Badge>
                </span>
                <Input
                  className="w-20"
                  data-testid={`row-zone-${id}-${zone.areaId}`}
                  defaultValue={zonePosition.get(`${zone.areaId}|${zone.checklistId}`) ?? ''}
                  min={0}
                  name={`zone-${zone.areaId}|${zone.checklistId}`}
                  step={1}
                  type="number"
                />
              </label>
            ))}
          </fieldset>
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

export function RotationRowsManager({ beds, houseId, rows, zones }: RotationRowsProps) {
  const t = useTranslations('rotationRows');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-6">
        {rows.map((row) => (
          <RowForm beds={beds} houseId={houseId} key={row.rowId} row={row} zones={zones} />
        ))}

        <div className="border-border border-t pt-4">
          <p className="text-text-muted mb-2 text-[13px]">{t('addRowTitle')}</p>
          <RowForm beds={beds} houseId={houseId} row={null} zones={zones} />
        </div>
      </div>
    </Card>
  );
}
