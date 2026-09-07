'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Money } from '@/components/ui/money';

import {
  addRatingEventAction,
  approveDiscountAction,
  cancelFineAction,
  type RatingEventActionState,
} from './actions';

const INITIAL: RatingEventActionState = {};

/** Действия админа из §5.2: список закрыт, коды приходят из правил. */
export interface ActionOption {
  code: string;
  delta: number;
}

export interface EventRow {
  id: string;
  type: string;
  delta: number;
  note: string | null;
  /** Дата события по календарю Алматы: считает её сервер, экран только печатает. */
  date: string;
}

export interface ThresholdView {
  kind: 'down' | 'up';
  threshold: number;
  armed: boolean;
  amount: number;
}

export interface FineRow {
  id: string;
  amount: number;
  reason: string;
  status: 'pending' | 'applied' | 'cancelled';
}

export interface DiscountRow {
  id: string;
  amount: number;
  status: 'proposed' | 'approved' | 'revoked';
}

export interface ResidentRatingViewProps {
  userId: string;
  name: string;
  rating: number;
  debts: number;
  events: readonly EventRow[];
  thresholds: readonly ThresholdView[];
  fines: readonly FineRow[];
  discounts: readonly DiscountRow[];
  actionOptions: readonly ActionOption[];
  canCancelFine: boolean;
  canApproveDiscount: boolean;
}

export function ResidentRatingView({
  actionOptions,
  canApproveDiscount,
  canCancelFine,
  debts,
  discounts,
  events,
  fines,
  name,
  rating,
  thresholds,
  userId,
}: ResidentRatingViewProps) {
  const t = useTranslations('rating');
  const [state, action, isPending] = useActionState(addRatingEventAction, INITIAL);
  const [fineState, fineAction] = useActionState(cancelFineAction, INITIAL);
  const [discountState, discountAction] = useActionState(approveDiscountAction, INITIAL);

  const label = (code: string): string =>
    actionOptions.some((option) => option.code === code) ? t(`action.${code}`) : code;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>{name}</CardTitle>
        <p className="mt-2 text-[32px] leading-none" data-testid="resident-rating">
          {rating}
        </p>
        <p className="text-text-muted mt-2 text-[13px]">{t('debtsCount', { count: debts })}</p>
      </Card>

      <Card>
        <CardTitle>{t('addEvent')}</CardTitle>
        <form action={action} className="mt-3 flex flex-col gap-3" data-testid="add-event">
          <input name="userId" type="hidden" value={userId} />

          <Field htmlFor="type" label={t('eventType')}>
            <Select data-testid="event-type" id="type" name="type">
              {actionOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {`${t(`action.${option.code}`)} (${option.delta > 0 ? '+' : ''}${option.delta})`}
                </option>
              ))}
            </Select>
          </Field>

          <Field htmlFor="reason" label={t('reason')}>
            <Input data-testid="event-reason" id="reason" name="reason" required />
          </Field>

          <Field htmlFor="note" label={t('note')}>
            <Textarea id="note" name="note" rows={2} />
          </Field>

          <div className="flex items-center gap-3">
            <Button disabled={isPending} type="submit">
              {t('submit')}
            </Button>
            {state.done !== undefined ? (
              <span className="text-success text-[13px]" data-testid="event-added" role="status">
                {t('done')}
              </span>
            ) : null}
            {state.error !== undefined ? (
              <span className="text-danger text-[13px]" role="alert">
                {t('failed')}
              </span>
            ) : null}
          </div>
        </form>
      </Card>

      <Card>
        <CardTitle>{t('history')}</CardTitle>
        <ul className="mt-3 flex flex-col gap-2" data-testid="rating-history">
          {events.map((event) => (
            <li className="flex items-baseline justify-between gap-4 text-[13px]" key={event.id}>
              <span>{label(event.type)}</span>
              <span className="text-text-muted">{event.note ?? ''}</span>
              <span className="tabular">{event.delta > 0 ? `+${event.delta}` : event.delta}</span>
              <span className="text-text-muted">{event.date}</span>
            </li>
          ))}
          {events.length === 0 ? (
            <li className="text-text-muted text-[13px]">{t('noEvents')}</li>
          ) : null}
        </ul>
      </Card>

      <Card>
        <CardTitle>{t('thresholds')}</CardTitle>
        <ul className="mt-3 flex flex-col gap-2" data-testid="rating-thresholds">
          {thresholds.map((row) => (
            <li
              className="flex items-baseline justify-between gap-4 text-[13px]"
              key={`${row.kind}:${row.threshold}`}
            >
              <span>
                {row.kind === 'down'
                  ? t('rules.downThreshold', { threshold: row.threshold })
                  : t('rules.upThreshold', { threshold: row.threshold })}
              </span>
              <Money amount={row.amount} />
              <span className="text-text-muted">{row.armed ? t('armed') : t('disarmed')}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardTitle>{t('fines')}</CardTitle>
        <ul className="mt-3 flex flex-col gap-2" data-testid="rating-fines">
          {fines.map((fine) => (
            <li className="flex items-baseline justify-between gap-4 text-[13px]" key={fine.id}>
              <span>{fine.reason}</span>
              <Money amount={fine.amount} />
              <span className="text-text-muted">{t(`fineStatus.${fine.status}`)}</span>
              {canCancelFine && fine.status !== 'cancelled' ? (
                <form action={fineAction} className="flex items-center gap-2">
                  <input name="userId" type="hidden" value={userId} />
                  <input name="fineId" type="hidden" value={fine.id} />
                  <Input
                    aria-label={t('cancelReason')}
                    className="w-40"
                    name="reason"
                    required
                    data-testid="fine-reason"
                  />
                  <Button type="submit" variant="secondary">
                    {t('cancelFine')}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
          {fines.length === 0 ? (
            <li className="text-text-muted text-[13px]">{t('noFines')}</li>
          ) : null}
        </ul>
        {fineState.error !== undefined ? (
          <p className="text-danger mt-2 text-[13px]" role="alert">
            {t('failed')}
          </p>
        ) : null}
      </Card>

      {discounts.length === 0 ? null : (
        <Card>
          <CardTitle>{t('discounts')}</CardTitle>
          <ul className="mt-3 flex flex-col gap-2" data-testid="rating-discounts">
            {discounts.map((discount) => (
              <li
                className="flex items-baseline justify-between gap-4 text-[13px]"
                key={discount.id}
              >
                <Money amount={discount.amount} />
                <span className="text-text-muted">{t(`discountStatus.${discount.status}`)}</span>
                {canApproveDiscount && discount.status === 'proposed' ? (
                  <form action={discountAction}>
                    <input name="userId" type="hidden" value={userId} />
                    <input name="discountId" type="hidden" value={discount.id} />
                    <Button type="submit" variant="secondary">
                      {t('approveDiscount')}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {discountState.error !== undefined ? (
            <p className="text-danger mt-2 text-[13px]" role="alert">
              {t('failed')}
            </p>
          ) : null}
        </Card>
      )}
    </div>
  );
}
