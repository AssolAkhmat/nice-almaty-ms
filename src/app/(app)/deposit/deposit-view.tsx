'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { parseInstant } from '@/lib/time';

import { issueDepositInvoiceAction, recordPaymentAction, type DepositActionState } from './actions';

export interface DepositMovementView {
  id: string;
  type: string;
  amount: number;
  note: string | null;
  createdAt: string;
  /** Сколько человек делили ущерб; у остальных движений пусто (§8). */
  participants: number | null;
}

export interface DepositInvoiceView {
  id: string;
  total: number;
  paid: number;
  remaining: number;
  status: string;
}

export interface DepositScreenView {
  residencyId: string;
  residentName: string | null;
  balance: number;
  year: number;
  movements: DepositMovementView[];
  invoice: DepositInvoiceView | null;
  /** Управление показывается только тем, кто вправе им пользоваться. */
  canManage: boolean;
}

const INITIAL: DepositActionState = {};

function Movements({ movements }: { movements: readonly DepositMovementView[] }) {
  const t = useTranslations();
  const format = useFormatter();

  if (movements.length === 0) {
    return <p className="text-text-muted text-[13px]">{t('deposit.noMovements')}</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {movements.map((movement) => (
        <li className="flex items-center justify-between gap-4" key={movement.id}>
          <span className="text-[13px]">
            {movement.note ?? t(`deposit.movement.${movement.type}`)}
            <span className="text-text-muted ml-2">
              {format.dateTime(parseInstant(movement.createdAt), {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              })}
            </span>
            {movement.participants !== null && (
              <span className="text-text-muted ml-2">
                {t('deposit.participants', { count: movement.participants })}
              </span>
            )}
          </span>
          <Money amount={movement.amount} />
        </li>
      ))}
    </ul>
  );
}

export function DepositScreen({ view }: { view: DepositScreenView }) {
  const t = useTranslations();
  const [issueState, issueAction, isIssuing] = useActionState(issueDepositInvoiceAction, INITIAL);
  const [paymentState, paymentAction, isRecording] = useActionState(recordPaymentAction, INITIAL);

  return (
    <Card data-testid="deposit-card">
      <CardHeader>
        <CardTitle>{view.residentName ?? t('deposit.title')}</CardTitle>
        <Money amount={view.balance} className="text-[15px]" />
      </CardHeader>

      <div className="flex flex-col gap-4 p-4 pt-0">
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-medium">{t('deposit.invoice')}</h2>

          {view.invoice === null ? (
            <p className="text-text-muted text-[13px]">{t('deposit.noInvoice')}</p>
          ) : (
            <div className="flex flex-col gap-1 text-[13px]">
              <div className="flex justify-between gap-4">
                <span>{t('deposit.total')}</span>
                <Money amount={view.invoice.total} />
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('deposit.paid')}</span>
                <Money amount={view.invoice.paid} />
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('deposit.remaining')}</span>
                <Money amount={view.invoice.remaining} />
              </div>
              <Badge tone={view.invoice.status === 'paid' ? 'success' : 'info'}>
                {t(`deposit.status.${view.invoice.status}`)}
              </Badge>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-medium">{t('deposit.movements', { year: view.year })}</h2>
          <Movements movements={view.movements} />
        </section>

        {view.canManage && (
          <section className="border-border flex flex-col gap-3 border-t pt-3">
            {issueState.error !== undefined && (
              <p className="text-danger text-[13px]" role="alert">
                {t(issueState.error)}
              </p>
            )}
            {paymentState.error !== undefined && (
              <p className="text-danger text-[13px]" role="alert">
                {t(paymentState.error)}
              </p>
            )}

            {view.invoice === null ? (
              <form action={issueAction} className="flex flex-col gap-2">
                <input name="residencyId" type="hidden" value={view.residencyId} />
                <Field
                  hint={t('deposit.amountHint')}
                  htmlFor={`amount-${view.residencyId}`}
                  label={t('deposit.amount')}
                >
                  <Input
                    data-testid="deposit-amount"
                    id={`amount-${view.residencyId}`}
                    inputMode="numeric"
                    name="amount"
                    step={1}
                    type="number"
                  />
                </Field>
                <Button disabled={isIssuing} type="submit">
                  {t('deposit.issue')}
                </Button>
              </form>
            ) : (
              view.invoice.remaining > 0 && (
                <form action={paymentAction} className="flex flex-col gap-2">
                  <input name="invoiceId" type="hidden" value={view.invoice.id} />
                  <Field htmlFor={`payment-${view.residencyId}`} label={t('deposit.paymentAmount')}>
                    <Input
                      data-testid="payment-amount"
                      defaultValue={view.invoice.remaining}
                      id={`payment-${view.residencyId}`}
                      inputMode="numeric"
                      name="amount"
                      step={1}
                      type="number"
                    />
                  </Field>
                  <Field htmlFor={`method-${view.residencyId}`} label={t('deposit.method')}>
                    <Select id={`method-${view.residencyId}`} name="method">
                      <option value="kaspi">Kaspi</option>
                      <option value="cash">{t('deposit.cash')}</option>
                    </Select>
                  </Field>
                  <Button disabled={isRecording} type="submit">
                    {t('deposit.record')}
                  </Button>
                </form>
              )
            )}
          </section>
        )}
      </div>
    </Card>
  );
}

export function DepositList({ views }: { views: readonly DepositScreenView[] }) {
  const t = useTranslations();

  if (views.length === 0) {
    return <EmptyState description={t('deposit.emptyHint')} title={t('deposit.empty')} />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {views.map((view) => (
        <DepositScreen key={view.residencyId} view={view} />
      ))}
    </div>
  );
}
