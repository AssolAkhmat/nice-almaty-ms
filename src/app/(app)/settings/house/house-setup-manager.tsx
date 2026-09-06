'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Money } from '@/components/ui/money';

import {
  archiveAreaAction,
  archiveBedAction,
  createAreaAction,
  createBedAction,
  updateAreaAction,
  updateBedAction,
  type HouseSetupActionState,
} from './actions';

const INITIAL: HouseSetupActionState = {};

export interface BedRow {
  bedId: string;
  label: string;
  number: number;
  tier: 'upper' | 'lower';
  defaultPrice: number;
  occupied: boolean;
}

export interface AreaRow {
  areaId: string;
  name: string;
  type: 'living' | 'common';
  sortOrder: number;
  beds: BedRow[];
}

export interface HouseSetupProps {
  houseId: string;
  depositDefault: number;
  areas: readonly AreaRow[];
}

function Message({ state }: { state: HouseSetupActionState }) {
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

/** Место: обозначение, номер, ярус и цена по умолчанию — одной строкой-формой. */
function BedForm({ bed }: { bed: BedRow }) {
  const t = useTranslations('houseSetup');
  const [saveState, saveAction, isSaving] = useActionState(updateBedAction, INITIAL);
  const [archiveState, archiveAction, isArchiving] = useActionState(archiveBedAction, INITIAL);

  return (
    <li className="border-border flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium">{bed.label}</span>
        <Badge tone={bed.occupied ? 'info' : 'neutral'}>
          {bed.occupied ? t('occupied') : t('free')}
        </Badge>
      </div>

      <form action={saveAction} className="flex flex-wrap items-end gap-2">
        <input name="bedId" type="hidden" value={bed.bedId} />

        <div className="min-w-[140px] flex-1">
          <Field htmlFor={`label-${bed.bedId}`} label={t('bedLabel')}>
            <Input defaultValue={bed.label} id={`label-${bed.bedId}`} name="label" required />
          </Field>
        </div>

        <div className="w-20">
          <Field htmlFor={`number-${bed.bedId}`} label={t('bedNumber')}>
            <Input
              defaultValue={bed.number}
              id={`number-${bed.bedId}`}
              min={1}
              name="number"
              required
              type="number"
            />
          </Field>
        </div>

        <div className="w-32">
          <Field htmlFor={`tier-${bed.bedId}`} label={t('tier')}>
            <Select defaultValue={bed.tier} id={`tier-${bed.bedId}`} name="tier">
              <option value="lower">{t('tiers.lower')}</option>
              <option value="upper">{t('tiers.upper')}</option>
            </Select>
          </Field>
        </div>

        <div className="w-36">
          <Field htmlFor={`price-${bed.bedId}`} label={t('defaultPrice')}>
            <Input
              defaultValue={bed.defaultPrice}
              id={`price-${bed.bedId}`}
              min={0}
              name="defaultPrice"
              required
              step={1}
              type="number"
            />
          </Field>
        </div>

        <Button disabled={isSaving} size="sm" type="submit" variant="secondary">
          {t('save')}
        </Button>
      </form>

      <Message state={saveState} />

      {!bed.occupied && (
        <form action={archiveAction}>
          <input name="bedId" type="hidden" value={bed.bedId} />
          <Button disabled={isArchiving} size="sm" type="submit" variant="ghost">
            {t('archiveBed')}
          </Button>
        </form>
      )}

      <Message state={archiveState} />
    </li>
  );
}

function NewBedForm({ areaId }: { areaId: string }) {
  const t = useTranslations('houseSetup');
  const [state, action, isPending] = useActionState(createBedAction, INITIAL);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input name="areaId" type="hidden" value={areaId} />

      <div className="min-w-[140px] flex-1">
        <Field htmlFor={`new-label-${areaId}`} label={t('bedLabel')}>
          <Input id={`new-label-${areaId}`} name="label" required />
        </Field>
      </div>

      <div className="w-20">
        <Field htmlFor={`new-number-${areaId}`} label={t('bedNumber')}>
          <Input
            defaultValue={1}
            id={`new-number-${areaId}`}
            min={1}
            name="number"
            required
            type="number"
          />
        </Field>
      </div>

      <div className="w-32">
        <Field htmlFor={`new-tier-${areaId}`} label={t('tier')}>
          <Select defaultValue="lower" id={`new-tier-${areaId}`} name="tier">
            <option value="lower">{t('tiers.lower')}</option>
            <option value="upper">{t('tiers.upper')}</option>
          </Select>
        </Field>
      </div>

      <div className="w-36">
        <Field htmlFor={`new-price-${areaId}`} label={t('defaultPrice')}>
          <Input
            defaultValue={0}
            id={`new-price-${areaId}`}
            min={0}
            name="defaultPrice"
            required
            step={1}
            type="number"
          />
        </Field>
      </div>

      <Button data-testid="add-bed" disabled={isPending} size="sm" type="submit">
        {t('addBed')}
      </Button>

      <div className="w-full">
        <Message state={state} />
      </div>
    </form>
  );
}

function AreaCard({ area }: { area: AreaRow }) {
  const t = useTranslations('houseSetup');
  const [saveState, saveAction, isSaving] = useActionState(updateAreaAction, INITIAL);
  const [archiveState, archiveAction, isArchiving] = useActionState(archiveAreaAction, INITIAL);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{area.name}</CardTitle>
        <Badge tone={area.type === 'living' ? 'info' : 'neutral'}>{t(`types.${area.type}`)}</Badge>
      </CardHeader>

      <div className="flex flex-col gap-4">
        <form action={saveAction} className="flex flex-wrap items-end gap-2">
          <input name="areaId" type="hidden" value={area.areaId} />

          <div className="min-w-[160px] flex-1">
            <Field htmlFor={`area-name-${area.areaId}`} label={t('areaName')}>
              <Input
                defaultValue={area.name}
                id={`area-name-${area.areaId}`}
                name="name"
                required
              />
            </Field>
          </div>

          <div className="w-24">
            <Field htmlFor={`area-order-${area.areaId}`} label={t('sortOrder')}>
              <Input
                defaultValue={area.sortOrder}
                id={`area-order-${area.areaId}`}
                name="sortOrder"
                type="number"
              />
            </Field>
          </div>

          <Button disabled={isSaving} size="sm" type="submit" variant="secondary">
            {t('save')}
          </Button>

          <div className="w-full">
            <Message state={saveState} />
          </div>
        </form>

        {area.type === 'living' && (
          <section className="flex flex-col gap-3">
            <h3 className="text-[13px] font-medium">{t('beds')}</h3>

            {area.beds.length === 0 ? (
              <p className="text-text-muted text-[13px]">{t('noBeds')}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {area.beds.map((bed) => (
                  <BedForm bed={bed} key={bed.bedId} />
                ))}
              </ul>
            )}

            <NewBedForm areaId={area.areaId} />
          </section>
        )}

        {area.beds.length === 0 && (
          <form action={archiveAction}>
            <input name="areaId" type="hidden" value={area.areaId} />
            <Button disabled={isArchiving} size="sm" type="submit" variant="ghost">
              {t('archiveArea')}
            </Button>
          </form>
        )}

        <Message state={archiveState} />
      </div>
    </Card>
  );
}

function NewAreaForm({ houseId }: { houseId: string }) {
  const t = useTranslations('houseSetup');
  const [state, action, isPending] = useActionState(createAreaAction, INITIAL);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('addAreaTitle')}</CardTitle>
      </CardHeader>

      <form action={action} className="flex flex-wrap items-end gap-2">
        <input name="houseId" type="hidden" value={houseId} />

        <div className="min-w-[160px] flex-1">
          <Field htmlFor="new-area-name" label={t('areaName')}>
            <Input id="new-area-name" name="name" required />
          </Field>
        </div>

        <div className="w-40">
          <Field htmlFor="new-area-type" label={t('areaType')}>
            <Select defaultValue="living" id="new-area-type" name="type">
              <option value="living">{t('types.living')}</option>
              <option value="common">{t('types.common')}</option>
            </Select>
          </Field>
        </div>

        <div className="w-24">
          <Field htmlFor="new-area-order" label={t('sortOrder')}>
            <Input defaultValue={0} id="new-area-order" name="sortOrder" type="number" />
          </Field>
        </div>

        <Button data-testid="add-area" disabled={isPending} size="sm" type="submit">
          {t('addArea')}
        </Button>

        <div className="w-full">
          <Message state={state} />
        </div>
      </form>
    </Card>
  );
}

/**
 * Настройка дома: зоны, места и цены по умолчанию (модуль 2).
 *
 * Цена по умолчанию — цена нового назначения; у уже живущего жильца цена
 * своя и здесь не меняется. Ни зона, ни место не удаляются: они уходят
 * в архив, потому что на них ссылается история занятости.
 */
export function HouseSetupManager({ areas, depositDefault, houseId }: HouseSetupProps) {
  const t = useTranslations('houseSetup');

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('depositTitle')}</CardTitle>
          <Money amount={depositDefault} />
        </CardHeader>
        <p className="text-text-muted text-[13px]">{t('depositHint')}</p>
      </Card>

      {areas.length === 0 ? (
        <EmptyState description={t('emptyHint')} title={t('empty')} />
      ) : (
        areas.map((area) => <AreaCard area={area} key={area.areaId} />)
      )}

      <NewAreaForm houseId={houseId} />
    </div>
  );
}
