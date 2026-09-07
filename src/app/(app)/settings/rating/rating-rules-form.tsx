'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';

import {
  copyRatingRulesAction,
  saveRatingRulesAction,
  type RatingRulesActionState,
} from './actions';

const INITIAL: RatingRulesActionState = {};

export interface RuleField {
  code: string;
  label: string;
  value: number;
  /** Действия порога вниз: они едут вместе с суммой штрафа. */
  actions?: string;
  /** Правило переопределено домом: видно, где живёт значение. */
  overridden: boolean;
}

export interface RatingRulesFormProps {
  houseId: string | null;
  houses: readonly { id: string; name: string }[];
  scores: readonly RuleField[];
  actions: readonly RuleField[];
  down: readonly RuleField[];
  up: readonly RuleField[];
}

function Section({ fields, title }: { fields: readonly RuleField[]; title: string }) {
  const t = useTranslations('rating.rules');

  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div className="mt-3 flex flex-col gap-3">
        {fields.map((field) => (
          <div className="flex items-center justify-between gap-4" key={field.code}>
            <label className="text-[15px]" htmlFor={`value:${field.code}`}>
              {field.label}
              {field.overridden ? (
                <span className="text-text-muted ml-2 text-[13px]">{t('overridden')}</span>
              ) : null}
            </label>
            <input name={`base:${field.code}`} type="hidden" value={String(field.value)} />
            {field.actions === undefined ? null : (
              <input name={`actions:${field.code}`} type="hidden" value={field.actions} />
            )}
            <Input
              className="w-28 text-right"
              defaultValue={String(field.value)}
              id={`value:${field.code}`}
              inputMode="numeric"
              name={`value:${field.code}`}
              type="number"
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Редактор правил рейтинга (§5.5).
 *
 * Одна форма на всю таблицу: сохраняется только то, что изменили —
 * иначе выбор дома сам по себе переопределял бы каждое правило сети.
 */
export function RatingRulesForm({
  actions,
  down,
  houseId,
  houses,
  scores,
  up,
}: RatingRulesFormProps) {
  const t = useTranslations('rating.rules');
  const [state, action, isPending] = useActionState(saveRatingRulesAction, INITIAL);
  const [copyState, copyAction, isCopying] = useActionState(copyRatingRulesAction, INITIAL);

  return (
    <div className="flex flex-col gap-6">
      <form action={action} className="flex flex-col gap-4" data-testid="rating-rules">
        <input name="houseId" type="hidden" value={houseId ?? ''} />

        <Section fields={scores} title={t('scores')} />
        <Section fields={actions} title={t('actions')} />
        <Section fields={down} title={t('down')} />
        <Section fields={up} title={t('up')} />

        <div className="flex items-center gap-4">
          <Button disabled={isPending} type="submit">
            {t('save')}
          </Button>
          {state.done !== undefined ? (
            <span className="text-success text-[13px]" data-testid="rules-saved" role="status">
              {t('saved')}
            </span>
          ) : null}
          {state.error !== undefined ? (
            <span className="text-danger text-[13px]" role="alert">
              {t('error')}
            </span>
          ) : null}
        </div>
      </form>

      {houseId === null ? null : (
        <Card>
          <CardTitle>{t('copyTitle')}</CardTitle>
          <form action={copyAction} className="mt-3 flex flex-wrap items-end gap-3">
            <input name="houseId" type="hidden" value={houseId} />
            <Select
              aria-label={t('copyFrom')}
              className="w-56"
              data-testid="copy-from"
              name="fromHouseId"
            >
              {houses
                .filter((house) => house.id !== houseId)
                .map((house) => (
                  <option key={house.id} value={house.id}>
                    {house.name}
                  </option>
                ))}
            </Select>
            <Button disabled={isCopying} type="submit" variant="secondary">
              {t('copy')}
            </Button>
            {copyState.done !== undefined ? (
              <span className="text-success text-[13px]" data-testid="rules-copied" role="status">
                {t('copied')}
              </span>
            ) : null}
            {copyState.error !== undefined ? (
              <span className="text-danger text-[13px]" role="alert">
                {t('error')}
              </span>
            ) : null}
          </form>
        </Card>
      )}
    </div>
  );
}
