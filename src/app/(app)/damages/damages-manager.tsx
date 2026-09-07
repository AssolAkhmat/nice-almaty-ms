'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { resolveDamageParticipants, splitDamage, type DamageSplitMode } from '@/domain/damage';
import { parseInstant } from '@/lib/time';

import { createDamageAction, reverseDamageAction, type DamageActionState } from './actions';

export interface RosterView {
  userId: string;
  name: string;
  areaId: string | null;
}

export interface AreaView {
  id: string;
  name: string;
}

export interface DamageShareView {
  userId: string;
  name: string;
  amount: number;
}

export interface DamageView {
  id: string;
  title: string;
  description: string | null;
  amount: number;
  surplus: number;
  splitMode: string;
  createdAt: string;
  reversed: boolean;
  shares: DamageShareView[];
}

export interface DamagesManagerProps {
  houseId: string;
  roster: readonly RosterView[];
  areas: readonly AreaView[];
  damages: readonly DamageView[];
  /** Сторнирование — только суперадмин (§8). */
  canReverse: boolean;
}

const MODES: readonly DamageSplitMode[] = ['single', 'room', 'all', 'all_except', 'custom'];

/** Режимы, которым нужен явный список жильцов. */
const PICKS_PEOPLE: readonly DamageSplitMode[] = ['single', 'all_except', 'custom'];

const INITIAL: DamageActionState = {};

/**
 * Предпросмотр считается теми же функциями, что и сохранение
 * (`src/domain/damage.ts`): второй расчёт на клиенте однажды разошёлся бы
 * с первым, и админ увидел бы не те суммы, которые спишутся.
 */
function usePreview(
  amount: number,
  mode: DamageSplitMode,
  chosen: readonly string[],
  areaId: string,
  roster: readonly RosterView[],
) {
  return useMemo(() => {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return null;
    }

    try {
      const participants = resolveDamageParticipants(
        { mode, config: { userIds: chosen, areaId: areaId === '' ? null : areaId } },
        roster.map((entry) => ({ userId: entry.userId, areaId: entry.areaId })),
      );

      const split = splitDamage(amount, participants);
      const names = new Map(roster.map((entry) => [entry.userId, entry.name]));

      return {
        shares: split.shares.map((share) => ({
          userId: share.userId,
          name: names.get(share.userId) ?? share.userId,
          amount: share.amount,
        })),
        surplus: split.surplus,
        charged: amount + split.surplus,
      };
    } catch {
      // Участников нет — предпросмотра тоже нет: показывать нечего.
      return null;
    }
  }, [amount, mode, chosen, areaId, roster]);
}

function DamageForm({
  houseId,
  roster,
  areas,
}: Omit<DamagesManagerProps, 'damages' | 'canReverse'>) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(createDamageAction, INITIAL);

  const [amount, setAmount] = useState(0);
  const [mode, setMode] = useState<DamageSplitMode>('all');
  const [chosen, setChosen] = useState<string[]>([]);
  const [areaId, setAreaId] = useState(areas[0]?.id ?? '');

  const preview = usePreview(amount, mode, chosen, areaId, roster);

  function toggle(userId: string): void {
    setChosen((current) =>
      current.includes(userId) ? current.filter((entry) => entry !== userId) : [...current, userId],
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('damages.create')}</CardTitle>
      </CardHeader>

      <form action={action} className="flex flex-col gap-4 p-4 pt-0">
        <input name="houseId" type="hidden" value={houseId} />
        {chosen.map((userId) => (
          <input key={userId} name="userIds" type="hidden" value={userId} />
        ))}
        <input name="areaId" type="hidden" value={mode === 'room' ? areaId : ''} />

        {state.error !== undefined && (
          <p className="text-danger text-[13px]" role="alert">
            {t(state.error)}
          </p>
        )}
        {state.done !== undefined && <p className="text-[13px]">{t(state.done)}</p>}

        <div className="grid gap-4 md:grid-cols-2">
          <Field htmlFor="damage-title" label={t('damages.titleField')}>
            <Input data-testid="damage-title" id="damage-title" name="title" required />
          </Field>

          <Field
            hint={t('damages.amountHint')}
            htmlFor="damage-amount"
            label={t('damages.amountField')}
          >
            <Input
              data-testid="damage-amount"
              id="damage-amount"
              inputMode="numeric"
              name="amount"
              onChange={(event) => {
                setAmount(Number(event.target.value));
              }}
              step={1}
              type="number"
            />
          </Field>
        </div>

        <Field htmlFor="damage-description" label={t('damages.descriptionField')}>
          <Textarea id="damage-description" name="description" rows={2} />
        </Field>

        <Field htmlFor="damage-mode" label={t('damages.mode')}>
          <Select
            data-testid="damage-mode"
            id="damage-mode"
            name="splitMode"
            onChange={(event) => {
              setMode(event.target.value as DamageSplitMode);
            }}
            value={mode}
          >
            {MODES.map((value) => (
              <option key={value} value={value}>
                {t(`damages.modes.${value}`)}
              </option>
            ))}
          </Select>
        </Field>

        {mode === 'room' && (
          <Field htmlFor="damage-area" label={t('damages.room')}>
            <Select
              id="damage-area"
              onChange={(event) => {
                setAreaId(event.target.value);
              }}
              value={areaId}
            >
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {PICKS_PEOPLE.includes(mode) && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-label">
              {mode === 'all_except' ? t('damages.exclude') : t('damages.participants')}
            </legend>

            <div className="grid gap-2 md:grid-cols-2">
              {roster.map((entry) => (
                <label className="flex items-center gap-2 text-[13px]" key={entry.userId}>
                  <Checkbox
                    checked={chosen.includes(entry.userId)}
                    onCheckedChange={() => {
                      toggle(entry.userId);
                    }}
                  />
                  {entry.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <section className="border-border flex flex-col gap-2 border-t pt-3">
          <h2 className="text-[13px] font-medium">{t('damages.preview')}</h2>

          {preview === null ? (
            <p className="text-text-muted text-[13px]">{t('damages.previewEmpty')}</p>
          ) : (
            <div className="flex flex-col gap-1 text-[13px]" data-testid="damage-preview">
              <div className="flex justify-between gap-4">
                <span>{t('damages.participantsCount', { count: preview.shares.length })}</span>
                <Money amount={preview.shares[0]?.amount ?? 0} />
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('damages.surplus')}</span>
                <Money amount={preview.surplus} />
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('damages.charged')}</span>
                <Money amount={preview.charged} />
              </div>
              <p className="text-text-muted">{t('damages.surplusHint')}</p>
            </div>
          )}
        </section>

        <Button disabled={isPending || preview === null} type="submit">
          {t('damages.submit')}
        </Button>
      </form>
    </Card>
  );
}

function DamageCard({ canReverse, damage }: { canReverse: boolean; damage: DamageView }) {
  const t = useTranslations();
  const format = useFormatter();
  const [state, action, isPending] = useActionState(reverseDamageAction, INITIAL);

  return (
    <Card data-testid="damage-card">
      <CardHeader>
        <CardTitle>{damage.title}</CardTitle>
        <Money amount={damage.amount} />
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={damage.reversed ? 'warning' : 'neutral'}>
            {damage.reversed ? t('damages.reversed') : t(`damages.modes.${damage.splitMode}`)}
          </Badge>
          <span className="text-text-muted">
            {format.dateTime(parseInstant(damage.createdAt), {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
            })}
          </span>
        </div>

        {damage.description !== null && <p>{damage.description}</p>}

        <ul className="flex flex-col gap-1">
          {damage.shares.map((share) => (
            <li className="flex items-center justify-between gap-4" key={share.userId}>
              <span>{share.name}</span>
              <Money amount={share.amount} />
            </li>
          ))}
        </ul>

        {damage.surplus > 0 && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">{t('damages.surplus')}</span>
            <Money amount={damage.surplus} />
          </div>
        )}

        {state.error !== undefined && (
          <p className="text-danger" role="alert">
            {t(state.error)}
          </p>
        )}

        {canReverse && !damage.reversed && (
          <form action={action}>
            <input name="damageId" type="hidden" value={damage.id} />
            <Button disabled={isPending} size="sm" type="submit" variant="danger">
              {t('damages.reverse')}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

export function DamagesManager({
  areas,
  canReverse,
  damages,
  houseId,
  roster,
}: DamagesManagerProps) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-6">
      <DamageForm areas={areas} houseId={houseId} roster={roster} />

      {damages.length === 0 ? (
        <EmptyState description={t('damages.emptyHint')} title={t('damages.empty')} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {damages.map((damage) => (
            <DamageCard canReverse={canReverse} damage={damage} key={damage.id} />
          ))}
        </div>
      )}
    </div>
  );
}
