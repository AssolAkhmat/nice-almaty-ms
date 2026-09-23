'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';

import { relocateAction, type RelocationActionState } from './actions';

export interface FreeBedView {
  houseId: string;
  houseName: string;
  bedId: string;
  label: string;
  defaultPrice: number;
}

export interface NamedGroupView {
  id: string;
  name: string;
}

export interface RelocationPanelProps {
  residencyId: string;
  today: string;
  /** Свободные места других домов сети. */
  beds: readonly FreeBedView[];
  /** Поимённые группы допуска покидаемого дома, где жилец назван. */
  groups: readonly NamedGroupView[];
}

const INITIAL: RelocationActionState = {};

/**
 * Переселение жильца в другой дом (решение D26).
 *
 * Дом не выбирается отдельно: его определяет место, а места сгруппированы
 * по домам. Так форма работает и без JavaScript — выпадающий список
 * не нужно перерисовывать после выбора дома.
 *
 * Группы допуска показываются, но по умолчанию не отмечены: человек может
 * вернуться, и снятое исключение стало бы тихим допуском туда, куда его
 * не пускали (указание владельца, 22 сентября 2026).
 */
export function RelocationPanel({ beds, groups, residencyId, today }: RelocationPanelProps) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(relocateAction, INITIAL);

  const houses = [...new Set(beds.map((bed) => bed.houseId))];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('residents.relocateTitle')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-4 p-4 pt-0">
        <p className="text-text-muted text-[13px]">{t('residents.relocateHint')}</p>

        {beds.length === 0 ? (
          <p className="text-text-muted text-[13px]">{t('residents.relocateNoBeds')}</p>
        ) : (
          <form action={action} className="flex flex-col gap-3">
            <input name="residencyId" type="hidden" value={residencyId} />

            {state.error !== undefined && (
              <p className="text-danger text-[13px]" role="alert">
                {t(state.error)}
              </p>
            )}

            {state.done !== undefined && (
              <p className="text-[13px]" role="status">
                {t(state.done)}
              </p>
            )}

            <div className="grid gap-3 md:grid-cols-3">
              <Field htmlFor="relocate-bed" label={t('residents.relocateBed')}>
                <Select data-testid="relocate-bed" id="relocate-bed" name="target" required>
                  <option value="">{t('residents.relocateChoose')}</option>
                  {houses.map((houseId) => (
                    <optgroup
                      key={houseId}
                      label={beds.find((bed) => bed.houseId === houseId)?.houseName ?? ''}
                    >
                      {beds
                        .filter((bed) => bed.houseId === houseId)
                        .map((bed) => (
                          <option key={bed.bedId} value={`${bed.houseId}:${bed.bedId}`}>
                            {bed.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </Select>
              </Field>

              <Field htmlFor="relocate-price" label={t('residents.relocatePrice')}>
                <Input
                  data-testid="relocate-price"
                  id="relocate-price"
                  inputMode="numeric"
                  name="price"
                  step={1}
                  type="number"
                />
              </Field>

              <Field htmlFor="relocate-from" label={t('residents.relocateFrom')}>
                <Input
                  data-testid="relocate-from"
                  defaultValue={today}
                  id="relocate-from"
                  name="from"
                  type="date"
                />
              </Field>
            </div>

            <p className="text-text-muted text-[13px]">{t('residents.relocatePriceHint')}</p>

            {groups.length > 0 && (
              <fieldset className="border-border flex flex-col gap-2 border-t pt-3">
                <legend className="text-[13px] font-medium">{t('residents.relocateGroups')}</legend>
                <p className="text-text-muted text-[13px]">{t('residents.relocateGroupsHint')}</p>

                {groups.map((group) => (
                  <label className="flex items-center gap-2 text-[13px]" key={group.id}>
                    <input name="leaveGroupIds" type="checkbox" value={group.id} />
                    {group.name}
                  </label>
                ))}
              </fieldset>
            )}

            <Button className="md:w-fit" disabled={isPending} size="sm" type="submit">
              {t('residents.relocate')}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}
