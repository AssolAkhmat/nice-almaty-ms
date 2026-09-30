'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Input, Select } from '@/components/ui/input';
import { Money } from '@/components/ui/money';

import { moveBedAction, type RelocationActionState } from './actions';

export interface HouseBedView {
  bedId: string;
  label: string;
  defaultPrice: number;
}

export interface BedMovePanelProps {
  residencyId: string;
  today: string;
  /** Свободные места этого же дома. */
  beds: readonly HouseBedView[];
  /** Цена действующего назначения. */
  currentPrice: number | null;
  /** С какого числа новая цена попадёт в счёт. */
  priceAppliesFrom: string;
  /** Есть ли проведённые начисления: от этого зависит доступность исправления. */
  hasPostedCharges: boolean;
}

const INITIAL: RelocationActionState = {};

/**
 * Переселение внутри дома (P1-5, указание владельца 27 сентября 2026).
 *
 * Три сценария в одном месте, но разными словами, потому что последствия
 * у них разные:
 *
 * - исправление ошибки ввода — прежнее назначение аннулируется целиком;
 *   доступно, только пока по проживанию нет начислений;
 * - временное размещение — расчётное место остаётся за жильцом, цена
 *   и начисления не меняются;
 * - постоянное переселение — назначение закрывается датой, открывается новое;
 *   при смене цены нужна отметка о согласии жильца (п. 6.2 Договора).
 *
 * Предпросмотр последствий стоит прямо в форме, а не появляется после
 * сохранения: цена сейчас, цена места, месяц вступления новой цены
 * и есть ли начисления.
 */
export function BedMovePanel({
  beds,
  currentPrice,
  hasPostedCharges,
  priceAppliesFrom,
  residencyId,
  today,
}: BedMovePanelProps) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(moveBedAction, INITIAL);

  /*
   * Поля ручного перерасчёта появляются ровно тогда, когда цена места
   * отличается от нынешней (D37): при равной цене месяц пересчитывать нечем,
   * и лишнее поле только сбивало бы.
   */
  const [bedId, setBedId] = useState(beds[0]?.bedId ?? '');
  const chosen = beds.find((bed) => bed.bedId === bedId);
  const priceChanges =
    currentPrice !== null && chosen !== undefined && chosen.defaultPrice !== currentPrice;

  return (
    <Card data-testid="bed-move-panel">
      <CardHeader>
        <CardTitle>{t('residents.moveTitle')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-4 p-4 pt-0">
        <p className="text-text-muted text-[13px]">{t('residents.moveHint')}</p>

        <dl className="grid gap-2 text-[13px] sm:grid-cols-3">
          <div>
            <dt className="text-label">{t('residents.movePriceNow')}</dt>
            <dd>{currentPrice === null ? '—' : <Money amount={currentPrice} />}</dd>
          </div>
          <div>
            <dt className="text-label">{t('residents.movePriceFrom')}</dt>
            <dd>{priceAppliesFrom}</dd>
          </div>
          <div>
            <dt className="text-label">{t('residents.moveCharges')}</dt>
            <dd>{t(hasPostedCharges ? 'residents.moveChargesYes' : 'residents.moveChargesNo')}</dd>
          </div>
        </dl>

        {beds.length === 0 ? (
          <p className="text-text-muted text-[13px]">{t('residents.moveNoBeds')}</p>
        ) : (
          <form action={action} className="flex flex-col gap-3" data-testid="bed-move-form">
            <input name="residencyId" type="hidden" value={residencyId} />

            {state.error !== undefined && (
              <p className="text-danger text-[13px]" data-testid="bed-move-error" role="alert">
                {t(state.error)}
              </p>
            )}

            {/* Что стало со счётом месяца — словами, а не молчанием (D37). */}
            {state.done !== undefined && (
              <p className="text-[13px]" data-testid="bed-move-done" role="status">
                {t(state.done)}
              </p>
            )}

            <Field
              hint={t('residents.moveKindHint')}
              htmlFor="move-kind"
              label={t('residents.moveKind')}
            >
              <Select data-testid="move-kind" defaultValue="permanent" id="move-kind" name="kind">
                <option value="permanent">{t('residents.moveKindPermanent')}</option>
                <option value="temporary">{t('residents.moveKindTemporary')}</option>
                <option disabled={hasPostedCharges} value="correction">
                  {t('residents.moveKindCorrection')}
                </option>
              </Select>
            </Field>

            <Field htmlFor="move-bed" label={t('residents.moveBed')}>
              <Select
                data-testid="move-bed"
                id="move-bed"
                name="bedId"
                onChange={(event) => setBedId(event.target.value)}
                required
                value={bedId}
              >
                {beds.map((bed) => (
                  <option key={bed.bedId} value={bed.bedId}>
                    {bed.label} — {bed.defaultPrice}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              hint={t('residents.moveFromHint')}
              htmlFor="move-from"
              label={t('residents.moveFrom')}
            >
              <Input
                data-testid="move-from"
                defaultValue={today}
                id="move-from"
                name="from"
                type="date"
              />
            </Field>

            <Field hint={t('residents.moveToHint')} htmlFor="move-to" label={t('residents.moveTo')}>
              <Input data-testid="move-to" id="move-to" name="to" type="date" />
            </Field>

            <Field htmlFor="move-reason" label={t('residents.moveReason')}>
              <Input data-testid="move-reason" id="move-reason" name="reason" required />
            </Field>

            {priceChanges && (
              <>
                <Field
                  hint={t('residents.moveMonthRentHint')}
                  htmlFor="move-month-rent"
                  label={t('residents.moveMonthRent')}
                >
                  <Input
                    data-testid="move-month-rent"
                    id="move-month-rent"
                    inputMode="numeric"
                    name="monthRent"
                    step={1}
                    type="number"
                  />
                </Field>

                <Field
                  htmlFor="move-month-rent-comment"
                  label={t('residents.moveMonthRentComment')}
                >
                  <Input
                    data-testid="move-month-rent-comment"
                    id="move-month-rent-comment"
                    name="monthRentComment"
                  />
                </Field>
              </>
            )}

            <label className="flex items-start gap-3 text-[13px]">
              <Checkbox data-testid="move-consent" name="consent" value="on" />
              <span>{t('residents.moveConsent')}</span>
            </label>

            <Field htmlFor="move-consent-date" label={t('residents.moveConsentDate')}>
              <Input
                data-testid="move-consent-date"
                defaultValue={today}
                id="move-consent-date"
                name="consentAgreedOn"
                type="date"
              />
            </Field>

            <Button data-testid="move-submit" disabled={isPending} type="submit">
              {t('residents.moveSubmit')}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}
