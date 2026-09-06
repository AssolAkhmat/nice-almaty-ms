'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Money } from '@/components/ui/money';

import { assignBedAction, type BedActionState } from './actions';

export interface BedSlot {
  bedId: string;
  label: string;
  defaultPrice: number;
  occupantName: string | null;
  occupantPrice: number | null;
}

export interface RoomView {
  areaId: string;
  name: string;
  beds: BedSlot[];
}

export interface UnplacedResident {
  residencyId: string;
  name: string;
}

const INITIAL: BedActionState = {};

/**
 * Схема дома и назначение места.
 *
 * Порядок в модалке тот же, что в модуле 1: комната → место → цена → дата.
 * Цена подставляется из места и правится вручную: индивидуальная цена —
 * обычное дело, а не исключение.
 */
export function HouseLayout({
  rooms,
  unplaced,
}: {
  rooms: readonly RoomView[];
  unplaced: readonly UnplacedResident[];
}) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(assignBedAction, INITIAL);
  const [isOpen, setOpen] = useState(false);
  const [areaId, setAreaId] = useState(rooms[0]?.areaId ?? '');

  const room = rooms.find((candidate) => candidate.areaId === areaId) ?? rooms[0];
  const freeBeds = room?.beds.filter((bed) => bed.occupantName === null) ?? [];

  if (rooms.length === 0) {
    return <EmptyState description={t('beds.emptyHint')} title={t('beds.empty')} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={unplaced.length === 0 || freeBeds.length === 0}
          onClick={() => {
            setOpen(true);
          }}
          type="button"
        >
          {t('beds.assign')}
        </Button>
        <span className="text-text-muted text-[13px]">
          {t('beds.unplaced', { count: unplaced.length })}
        </span>
      </div>

      {state.done !== undefined && <p className="text-success text-[13px]">{t(state.done)}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {rooms.map((current) => (
          <Card data-testid="room-card" key={current.areaId}>
            <CardHeader>
              <CardTitle>{current.name}</CardTitle>
              <Badge tone="neutral">
                {t('beds.occupancy', {
                  taken: current.beds.filter((bed) => bed.occupantName !== null).length,
                  total: current.beds.length,
                })}
              </Badge>
            </CardHeader>

            <ul className="flex flex-col gap-2 p-4 pt-0">
              {current.beds.map((bed) => (
                <li className="flex items-center justify-between gap-4 text-[13px]" key={bed.bedId}>
                  <span>
                    {bed.label}
                    <span className="text-text-muted ml-2">
                      {bed.occupantName ?? t('beds.free')}
                    </span>
                  </span>
                  <Money amount={bed.occupantPrice ?? bed.defaultPrice} />
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>

      <Modal
        description={t('beds.assignHint')}
        onOpenChange={setOpen}
        open={isOpen}
        title={t('beds.assign')}
      >
        <form action={action} className="flex flex-col gap-3">
          <Field htmlFor="assign-resident" label={t('beds.resident')}>
            <Select id="assign-resident" name="residencyId" required>
              {unplaced.map((resident) => (
                <option key={resident.residencyId} value={resident.residencyId}>
                  {resident.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field htmlFor="assign-room" label={t('beds.room')}>
            <Select
              id="assign-room"
              onChange={(event) => {
                setAreaId(event.target.value);
              }}
              value={room?.areaId ?? ''}
            >
              {rooms.map((current) => (
                <option key={current.areaId} value={current.areaId}>
                  {current.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field htmlFor="assign-bed" label={t('beds.bed')}>
            <Select id="assign-bed" name="bedId" required>
              {freeBeds.map((bed) => (
                <option key={bed.bedId} value={bed.bedId}>
                  {bed.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field hint={t('beds.priceHint')} htmlFor="assign-price" label={t('beds.price')}>
            <Input
              defaultValue={freeBeds[0]?.defaultPrice ?? ''}
              id="assign-price"
              inputMode="numeric"
              name="price"
              step={1}
              type="number"
            />
          </Field>

          <Field htmlFor="assign-from" label={t('beds.from')}>
            <Input id="assign-from" name="from" type="date" />
          </Field>

          {state.error !== undefined && (
            <p className="text-danger text-[13px]" role="alert">
              {t(state.error)}
            </p>
          )}

          <Button disabled={isPending} type="submit">
            {t('beds.confirm')}
          </Button>
        </form>
      </Modal>
    </div>
  );
}
