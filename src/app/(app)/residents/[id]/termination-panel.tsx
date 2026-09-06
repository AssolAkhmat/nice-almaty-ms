'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Money } from '@/components/ui/money';
import { parseBusinessDate, startOfDayUtc } from '@/lib/time';

import {
  archiveResidencyAction,
  createRefundInvoiceAction,
  settleRefundAction,
  terminateResidencyAction,
  type TerminationActionState,
} from './actions';

const INITIAL: TerminationActionState = {};

export interface TerminationPanelView {
  residencyId: string;
  status: string;
  /** Сегодня по календарю Алматы: значение по умолчанию для даты выезда. */
  today: string;
  moveOutDate: string | null;
  balance: number;
  damages: number;
  fullMonths: number;
  deadline: string | null;
  daysLeft: number | null;
  outcome: 'refund' | 'burn' | 'nothing' | 'debt';
  debt: number;
  refundInvoice: { id: string; total: number; status: string } | null;
  canArchive: boolean;
}

function Message({ state }: { state: TerminationActionState }) {
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

/**
 * Расторжение договора: модалка с датой выезда и причиной (модуль 1).
 * Действие опасное, поэтому подтверждение отдельным шагом, а кнопка —
 * в опасном варианте (docs/05-DESIGN-SYSTEM.md).
 */
function TerminateDialog({ residencyId, today }: { residencyId: string; today: string }) {
  const t = useTranslations('terminations');
  const [requested, setRequested] = useState(false);
  const [state, action, isPending] = useActionState(terminateResidencyAction, INITIAL);

  /*
   * Договор расторгнут — модалке больше нечего показывать, за ней уже расчёт.
   * Открытость выводится, а не хранится вторым состоянием: после успеха
   * этой формы на экране нет вовсе, и открывать её повторно неоткуда.
   */
  const open = requested && state.done === undefined;

  return (
    <>
      <Button
        data-testid="terminate-open"
        onClick={() => {
          setRequested(true);
        }}
        variant="danger"
      >
        {t('terminate')}
      </Button>

      <Modal
        description={t('modalHint')}
        onOpenChange={setRequested}
        open={open}
        title={t('modalTitle')}
      >
        <form action={action} className="flex flex-col gap-3">
          <input name="residencyId" type="hidden" value={residencyId} />

          <Field htmlFor="moveOutDate" hint={t('moveOutHint')} label={t('moveOutDate')}>
            <Input
              defaultValue={today}
              id="moveOutDate"
              min={today}
              name="moveOutDate"
              required
              type="date"
            />
          </Field>

          <Field htmlFor="reason" label={t('reason')}>
            <Textarea id="reason" name="reason" required rows={3} />
          </Field>

          <Message state={state} />

          <Button
            data-testid="terminate-confirm"
            disabled={isPending}
            type="submit"
            variant="danger"
          >
            {t('confirm')}
          </Button>
        </form>
      </Modal>
    </>
  );
}

/** Экран расчёта: остаток, ущерб, счётчик дней и кнопка счёта возврата. */
export function TerminationPanel({ view }: { view: TerminationPanelView }) {
  const t = useTranslations();
  const format = useFormatter();
  const [refundState, refundAction, isIssuing] = useActionState(createRefundInvoiceAction, INITIAL);
  const [settleState, settleAction, isSettling] = useActionState(settleRefundAction, INITIAL);
  const [archiveState, archiveAction, isArchiving] = useActionState(
    archiveResidencyAction,
    INITIAL,
  );

  const date = (value: string) =>
    format.dateTime(startOfDayUtc(parseBusinessDate(value)), {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

  if (view.status === 'active') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('terminations.title')}</CardTitle>
        </CardHeader>

        <div className="flex flex-col gap-3 p-4 pt-0">
          <p className="text-text-muted text-[13px]">{t('terminations.hint')}</p>
          <TerminateDialog residencyId={view.residencyId} today={view.today} />
        </div>
      </Card>
    );
  }

  return (
    <Card data-testid="termination-panel">
      <CardHeader>
        <CardTitle>{t('terminations.settlementTitle')}</CardTitle>
        <Badge tone={view.status === 'archived' ? 'neutral' : 'warning'}>
          {t(`residents.statuses.${view.status}`)}
        </Badge>
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0 text-[13px]">
        {view.moveOutDate !== null && (
          <div className="flex justify-between gap-4">
            <span>{t('terminations.moveOutDate')}</span>
            <span>{date(view.moveOutDate)}</span>
          </div>
        )}

        <div className="flex justify-between gap-4">
          <span>{t('terminations.balance')}</span>
          <Money amount={view.balance} />
        </div>

        <div className="flex justify-between gap-4">
          <span>{t('terminations.damages')}</span>
          <Money amount={view.damages} />
        </div>

        <div className="flex justify-between gap-4">
          <span>{t('terminations.fullMonths')}</span>
          <span className="tabular">{view.fullMonths}</span>
        </div>

        {view.deadline !== null && (
          <div className="flex justify-between gap-4">
            <span>{t('terminations.deadline')}</span>
            <span>{date(view.deadline)}</span>
          </div>
        )}

        {view.daysLeft !== null && (
          <div className="flex justify-between gap-4">
            <span>{t('terminations.daysLeft')}</span>
            <span data-testid="termination-days-left">
              {view.daysLeft < 0
                ? t('terminations.overdue', { days: -view.daysLeft })
                : t('terminations.days', { days: view.daysLeft })}
            </span>
          </div>
        )}

        <div className="flex justify-between gap-4">
          <span>{t('terminations.outcome')}</span>
          <span data-testid="termination-outcome">
            {t(`terminations.outcomes.${view.outcome}`)}
          </span>
        </div>

        {view.outcome === 'debt' && (
          <div className="flex justify-between gap-4">
            <span>{t('terminations.debt')}</span>
            <Money amount={-view.debt} />
          </div>
        )}

        {view.refundInvoice === null ? (
          view.status === 'terminating' && (
            <form action={refundAction} className="flex flex-col gap-2 pt-1">
              <input name="residencyId" type="hidden" value={view.residencyId} />
              <Message state={refundState} />
              <Button data-testid="create-refund" disabled={isIssuing} type="submit">
                {t('terminations.createRefund')}
              </Button>
            </form>
          )
        ) : (
          <div className="flex flex-col gap-2 pt-1">
            <div className="flex items-center justify-between gap-4">
              <span>{t('terminations.refundInvoice')}</span>
              <Money amount={view.refundInvoice.total} />
            </div>
            <Badge
              tone={
                view.refundInvoice.status === 'returned'
                  ? 'success'
                  : view.refundInvoice.status === 'burned'
                    ? 'danger'
                    : 'info'
              }
            >
              {t(`terminations.refundStatus.${view.refundInvoice.status}`)}
            </Badge>

            {view.refundInvoice.status === 'pending' && (
              <form action={settleAction} className="flex flex-col gap-2">
                <input name="invoiceId" type="hidden" value={view.refundInvoice.id} />
                <Message state={settleState} />
                <Button data-testid="settle-refund" disabled={isSettling} type="submit">
                  {t('terminations.settle')}
                </Button>
              </form>
            )}
          </div>
        )}

        {view.canArchive && (
          <form action={archiveAction} className="flex flex-col gap-2 pt-1">
            <input name="residencyId" type="hidden" value={view.residencyId} />
            <Message state={archiveState} />
            <Button
              data-testid="archive-residency"
              disabled={isArchiving}
              type="submit"
              variant="secondary"
            >
              {t('terminations.archive')}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}
