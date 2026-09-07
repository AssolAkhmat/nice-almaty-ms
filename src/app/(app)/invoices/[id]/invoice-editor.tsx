'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Money } from '@/components/ui/money';

import {
  cancelInvoiceAction,
  editInvoiceLinesAction,
  recalculateInvoiceAction,
  type InvoiceActionState,
} from '../actions';

import type { InvoiceLineKind } from '@/domain/invoice';

export interface EditableLine {
  kind: InvoiceLineKind;
  title: string;
  amount: number;
}

export interface InvoiceEditorProps {
  invoiceId: string;
  lines: readonly EditableLine[];
  /** Оплаченный и отменённый счёт не правится: только сторно и новый счёт. */
  editable: boolean;
  /** Пересчёт есть только у месячного счёта: у прочих нечего перестраивать. */
  recalculable: boolean;
  cancellable: boolean;
}

const INITIAL: InvoiceActionState = {};

const KINDS: readonly InvoiceLineKind[] = [
  'rent',
  'utilities',
  'damage_carryover',
  'proration',
  'extra',
];

export function InvoiceEditor({
  cancellable,
  editable,
  invoiceId,
  lines,
  recalculable,
}: InvoiceEditorProps) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(editInvoiceLinesAction, INITIAL);
  const [recalcState, recalcAction, isRecalculating] = useActionState(
    recalculateInvoiceAction,
    INITIAL,
  );
  const [cancelState, cancelAction, isCancelling] = useActionState(cancelInvoiceAction, INITIAL);
  const [draft, setDraft] = useState<EditableLine[]>([...lines]);

  const total = draft.reduce((sum, line) => sum + line.amount, 0);

  function update(index: number, patch: Partial<EditableLine>): void {
    setDraft((current) => current.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('invoices.lines')}</CardTitle>
        <Money amount={total} />
      </CardHeader>

      <div className="flex flex-col gap-4 p-4 pt-0">
        {[state, recalcState, cancelState].map((current, index) =>
          current.error === undefined ? null : (
            <p className="text-danger text-[13px]" key={String(index)} role="alert">
              {t(current.error)}
            </p>
          ),
        )}

        {!editable ? (
          <ul className="flex flex-col gap-1 text-[13px]">
            {draft.map((line, index) => (
              <li
                className="flex items-center justify-between gap-4"
                key={`${line.title}-${String(index)}`}
              >
                <span>{line.title}</span>
                <Money amount={line.amount} />
              </li>
            ))}
            <li className="text-text-muted">{t('invoices.closedHint')}</li>
          </ul>
        ) : (
          <form action={action} className="flex flex-col gap-3">
            <input name="invoiceId" type="hidden" value={invoiceId} />

            {draft.map((line, index) => (
              <div
                className="grid items-end gap-3 md:grid-cols-[1fr_2fr_1fr_auto]"
                key={`line-${String(index)}`}
              >
                <Field htmlFor={`kind-${String(index)}`} label={t('invoices.lineKind')}>
                  <Select
                    id={`kind-${String(index)}`}
                    name="lineKind"
                    onChange={(event) => {
                      update(index, { kind: event.target.value as InvoiceLineKind });
                    }}
                    value={line.kind}
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`invoices.kind.${kind}`)}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field htmlFor={`title-${String(index)}`} label={t('invoices.lineTitle')}>
                  <Input
                    id={`title-${String(index)}`}
                    name="lineTitle"
                    onChange={(event) => {
                      update(index, { title: event.target.value });
                    }}
                    value={line.title}
                  />
                </Field>

                <Field htmlFor={`amount-${String(index)}`} label={t('invoices.lineAmount')}>
                  <Input
                    id={`amount-${String(index)}`}
                    inputMode="numeric"
                    name="lineAmount"
                    onChange={(event) => {
                      update(index, { amount: Number(event.target.value) });
                    }}
                    step={1}
                    type="number"
                    value={line.amount}
                  />
                </Field>

                <Button
                  onClick={() => {
                    setDraft((current) => current.filter((_, at) => at !== index));
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t('common.remove')}
                </Button>
              </div>
            ))}

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setDraft((current) => [...current, { kind: 'extra', title: '', amount: 0 }]);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                {t('invoices.addLine')}
              </Button>

              <Button disabled={isPending || draft.length === 0} size="sm" type="submit">
                {t('invoices.saveLines')}
              </Button>
            </div>
          </form>
        )}

        <div className="border-border flex flex-wrap gap-2 border-t pt-3">
          {recalculable && (
            <form action={recalcAction}>
              <input name="invoiceId" type="hidden" value={invoiceId} />
              <Button disabled={isRecalculating} size="sm" type="submit" variant="secondary">
                {t('invoices.recalculate')}
              </Button>
            </form>
          )}

          {cancellable && (
            <form action={cancelAction}>
              <input name="invoiceId" type="hidden" value={invoiceId} />
              <Button disabled={isCancelling} size="sm" type="submit" variant="danger">
                {t('invoices.cancel')}
              </Button>
            </form>
          )}
        </div>

        {recalculable && <p className="text-text-muted text-[13px]">{t('invoices.recalcHint')}</p>}
      </div>
    </Card>
  );
}
