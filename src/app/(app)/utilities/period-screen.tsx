'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { Table } from '@/components/ui/table';
import { ReceiptUpload } from '@/components/upload/receipt-upload';

import {
  addLineAction,
  closePeriodAction,
  removeLineAction,
  reopenPeriodAction,
  type UtilityActionState,
} from './actions';

export interface PeriodLineView {
  id: string;
  title: string;
  amount: number;
  receiptFileId: string | null;
}

export interface AllocationRowView {
  userId: string;
  name: string;
  days: number;
  amount: number;
}

export interface PeriodScreenProps {
  periodId: string;
  houseId: string;
  month: string;
  closed: boolean;
  lines: readonly PeriodLineView[];
  total: number;
  rows: readonly AllocationRowView[];
  surplus: number;
  /** Сумма, которую не на кого делить: в доме за месяц никто не жил. */
  undistributed: number;
  canManage: boolean;
  canReopen: boolean;
}

const INITIAL: UtilityActionState = {};

function LineForm({ houseId, periodId }: { houseId: string; periodId: string }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(addLineAction, INITIAL);

  return (
    <form action={action} className="grid items-end gap-3 md:grid-cols-[2fr_1fr_1fr_auto]">
      <input name="periodId" type="hidden" value={periodId} />

      {state.error !== undefined && (
        <p className="text-danger text-[13px] md:col-span-4" role="alert">
          {t(state.error)}
        </p>
      )}

      <Field htmlFor="utility-title" label={t('utilities.lineTitle')}>
        <Input data-testid="utility-title" id="utility-title" name="title" required />
      </Field>

      <Field htmlFor="utility-amount" label={t('utilities.lineAmount')}>
        <Input
          data-testid="utility-amount"
          id="utility-amount"
          inputMode="numeric"
          name="amount"
          step={1}
          type="number"
        />
      </Field>

      <ReceiptUpload
        houseId={houseId}
        id="utility-receipt"
        name="receiptFileId"
        purpose="utility-receipt"
      />

      <Button disabled={isPending} size="sm" type="submit">
        {t('utilities.addLine')}
      </Button>
    </form>
  );
}

function RemoveLine({ lineId }: { lineId: string }) {
  const t = useTranslations();
  const [, action, isPending] = useActionState(removeLineAction, INITIAL);

  return (
    <form action={action}>
      <input name="lineId" type="hidden" value={lineId} />
      <Button disabled={isPending} size="sm" type="submit" variant="ghost">
        {t('common.remove')}
      </Button>
    </form>
  );
}

export function PeriodScreen({
  canManage,
  canReopen,
  closed,
  houseId,
  lines,
  periodId,
  rows,
  surplus,
  total,
  undistributed,
}: PeriodScreenProps) {
  const t = useTranslations();
  const [closeState, closeAction, isClosing] = useActionState(closePeriodAction, INITIAL);
  const [reopenState, reopenAction, isReopening] = useActionState(reopenPeriodAction, INITIAL);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('utilities.lines')}</CardTitle>
          <Money amount={total} />
        </CardHeader>

        <div className="flex flex-col gap-4 p-4 pt-0">
          <Badge tone={closed ? 'success' : 'info'}>
            {closed ? t('utilities.status.closed') : t('utilities.status.draft')}
          </Badge>

          {lines.length === 0 ? (
            <p className="text-text-muted text-[13px]">{t('utilities.noLines')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {lines.map((line) => (
                <li className="flex items-center justify-between gap-4" key={line.id}>
                  <span>{line.title}</span>
                  <span className="flex items-center gap-3">
                    {line.receiptFileId !== null && (
                      <a
                        className="text-text-muted hover:text-text underline-offset-2 hover:underline"
                        href={`/api/v1/files/${line.receiptFileId}/content`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {t('files.receipt')}
                      </a>
                    )}
                    <Money amount={line.amount} />
                    {canManage && !closed && <RemoveLine lineId={line.id} />}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {canManage && !closed && <LineForm houseId={houseId} periodId={periodId} />}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {closed ? t('utilities.allocation') : t('utilities.previewAllocation')}
          </CardTitle>
        </CardHeader>

        <div className="flex flex-col gap-3 p-4 pt-0">
          <Table
            caption={t('utilities.allocationCaption')}
            columns={[
              { key: 'name', header: t('utilities.resident'), cell: (row) => row.name },
              {
                key: 'days',
                header: t('utilities.days'),
                numeric: true,
                cell: (row) => row.days,
              },
              {
                key: 'amount',
                header: t('utilities.share'),
                numeric: true,
                cell: (row) => <Money amount={row.amount} />,
              },
            ]}
            emptyState={
              <EmptyState
                description={t('utilities.noParticipantsHint')}
                title={t('utilities.noParticipants')}
              />
            }
            rowKey={(row) => row.userId}
            rows={rows}
          />

          <div className="flex flex-col gap-1 text-[13px]">
            <div className="flex justify-between gap-4">
              <span>{t('utilities.surplus')}</span>
              <Money amount={surplus} />
            </div>
            {undistributed > 0 && (
              <div className="flex justify-between gap-4">
                <span className="text-danger">{t('utilities.undistributed')}</span>
                <Money amount={undistributed} />
              </div>
            )}
            <p className="text-text-muted">{t('utilities.surplusHint')}</p>
          </div>

          {[closeState, reopenState].map((state, index) =>
            state.error === undefined ? null : (
              <p className="text-danger text-[13px]" key={String(index)} role="alert">
                {t(state.error)}
              </p>
            ),
          )}

          <div className="border-border flex flex-wrap gap-2 border-t pt-3">
            {canManage && !closed && (
              <form action={closeAction}>
                <input name="periodId" type="hidden" value={periodId} />
                <Button data-testid="close-period" disabled={isClosing} size="sm" type="submit">
                  {t('utilities.close')}
                </Button>
              </form>
            )}

            {canReopen && closed && (
              <form action={reopenAction}>
                <input name="periodId" type="hidden" value={periodId} />
                <Button disabled={isReopening} size="sm" type="submit" variant="danger">
                  {t('utilities.reopen')}
                </Button>
              </form>
            )}
          </div>

          {closed && <p className="text-text-muted text-[13px]">{t('utilities.closedHint')}</p>}
        </div>
      </Card>
    </div>
  );
}
