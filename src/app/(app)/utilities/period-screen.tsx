'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { FileLinks } from '@/components/files/file-links';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Input, Select } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { Table } from '@/components/ui/table';
import { ReceiptUpload } from '@/components/upload/receipt-upload';

import {
  addLineAction,
  closePeriodAction,
  correctDaysAction,
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

export interface HistoryRowView {
  periodId: string;
  month: string;
  total: number;
  participants: number;
  days: number;
  averageShare: number;
}

export interface AllocationRowView {
  userId: string;
  name: string;
  /** Что посчитала формула §4.2. */
  systemDays: number;
  /** Что пошло в деньги: корректировка, если она есть. */
  days: number;
  amount: number;
  /** Причина корректировки; пусто — правки не было. */
  comment: string | null;
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
  history: readonly HistoryRowView[];
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

/**
 * Корректировка человеко-дней (P2-6, указание владельца 27 сентября 2026).
 *
 * Два направления в одной форме, но неравноправные: уменьшение уходит
 * сохранением сразу, увеличение требует отметки, и предупреждение появляется
 * ровно тогда, когда введённое число больше расчётного, — а не висит
 * над формой всегда.
 *
 * «Пересчитать» показывает последствия до записи: те же доли, посчитанные
 * сервером тем же кодом, что и сохранение.
 */
function DaysForm({ periodId, rows }: { periodId: string; rows: readonly AllocationRowView[] }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(correctDaysAction, INITIAL);
  const [userId, setUserId] = useState(rows[0]?.userId ?? '');
  const [days, setDays] = useState('');
  const [comment, setComment] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const selected = rows.find((row) => row.userId === userId);
  const increases = selected !== undefined && days !== '' && Number(days) > selected.systemDays;

  return (
    <form action={action} className="flex flex-col gap-3" data-testid="days-form">
      <input name="periodId" type="hidden" value={periodId} />

      <h3 className="font-medium">{t('utilities.correctionTitle')}</h3>
      <p className="text-text-muted text-[13px]">{t('utilities.correctionHint')}</p>

      {state.error !== undefined && (
        <p className="text-danger text-[13px]" data-testid="days-error" role="alert">
          {t(state.error)}
        </p>
      )}

      {state.done !== undefined && (
        <p className="text-[13px]" data-testid="days-done">
          {t(state.done)}
        </p>
      )}

      <div className="grid items-end gap-3 md:grid-cols-[2fr_1fr_3fr]">
        <Field htmlFor="days-user" label={t('utilities.resident')}>
          <Select
            data-testid="days-user"
            id="days-user"
            name="userId"
            onChange={(event) => setUserId(event.target.value)}
            value={userId}
          >
            {rows.map((row) => (
              <option key={row.userId} value={row.userId}>
                {row.name} — {row.systemDays}
              </option>
            ))}
          </Select>
        </Field>

        <Field htmlFor="days-value" label={t('utilities.correctionDays')}>
          <Input
            data-testid="days-value"
            id="days-value"
            inputMode="numeric"
            name="days"
            onChange={(event) => setDays(event.target.value)}
            step={1}
            type="number"
            value={days}
          />
        </Field>

        <Field htmlFor="days-comment" label={t('utilities.correctionComment')}>
          <Input
            data-testid="days-comment"
            id="days-comment"
            name="comment"
            onChange={(event) => setComment(event.target.value)}
            value={comment}
          />
        </Field>
      </div>

      {increases && (
        <div className="flex flex-col gap-2">
          <p className="text-danger text-[13px]" data-testid="days-warning" role="alert">
            {t('utilities.correctionWarning')}
          </p>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox
              checked={confirmed}
              data-testid="days-confirm"
              name="confirmIncrease"
              onCheckedChange={(next) => setConfirmed(next === true)}
              value="on"
            />
            <span>{t('utilities.correctionConfirm')}</span>
          </label>
        </div>
      )}

      {state.preview !== undefined && (
        <div className="border-border flex flex-col gap-1 border-t pt-3 text-[13px]">
          <h4 className="font-medium">{t('utilities.correctionPreviewTitle')}</h4>
          <ul className="flex flex-col gap-1" data-testid="days-preview">
            {state.preview.rows.map((row) => (
              <li className="flex justify-between gap-4" key={row.userId}>
                <span>
                  {row.name} — {row.days}
                </span>
                <Money amount={row.amount} />
              </li>
            ))}
          </ul>
          <div className="flex justify-between gap-4">
            <span>{t('utilities.surplus')}</span>
            <Money amount={state.preview.surplus} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="days-preview-submit"
          disabled={isPending}
          name="intent"
          size="sm"
          type="submit"
          value="preview"
          variant="ghost"
        >
          {t('utilities.correctionPreview')}
        </Button>
        <Button
          data-testid="days-save"
          disabled={isPending || (increases && !confirmed)}
          name="intent"
          size="sm"
          type="submit"
          value="save"
        >
          {t('utilities.correctionSave')}
        </Button>
      </div>
    </form>
  );
}

/** История по дому: месяц, сумма, средняя доля, число жильцов и дней. */
function History({ rows }: { rows: readonly HistoryRowView[] }) {
  const t = useTranslations();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('utilities.history')}</CardTitle>
      </CardHeader>
      <div className="p-4 pt-0">
        <Table
          caption={t('utilities.history')}
          columns={[
            { key: 'month', header: t('utilities.month'), cell: (row) => row.month.slice(0, 7) },
            {
              key: 'total',
              header: t('utilities.total'),
              numeric: true,
              cell: (row) => <Money amount={row.total} />,
            },
            {
              key: 'participants',
              header: t('utilities.residents'),
              numeric: true,
              cell: (row) => row.participants,
            },
            {
              key: 'days',
              header: t('utilities.days'),
              numeric: true,
              cell: (row) => row.days,
            },
            {
              key: 'average',
              header: t('utilities.averageShare'),
              numeric: true,
              cell: (row) => <Money amount={row.averageShare} />,
            },
          ]}
          emptyState={
            <EmptyState
              description={t('utilities.noHistoryHint')}
              title={t('utilities.noHistory')}
            />
          }
          rowKey={(row) => row.periodId}
          rows={rows}
        />
      </div>
    </Card>
  );
}

export function PeriodScreen({
  canManage,
  canReopen,
  closed,
  history,
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
                <li
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                  key={line.id}
                >
                  <span>{line.title}</span>
                  <span className="flex items-center gap-3">
                    {line.receiptFileId !== null && (
                      <FileLinks fileId={line.receiptFileId} label={t('files.receipt')} />
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
              {
                key: 'name',
                header: t('utilities.resident'),
                cell: (row) => (
                  <span className="flex flex-col">
                    <span>{row.name}</span>
                    {row.comment !== null && (
                      <span className="text-text-muted text-[12px]">{row.comment}</span>
                    )}
                  </span>
                ),
              },
              {
                key: 'systemDays',
                header: t('utilities.systemDays'),
                numeric: true,
                cell: (row) => row.systemDays,
              },
              {
                key: 'correction',
                header: t('utilities.correctionColumn'),
                numeric: true,
                cell: (row) => (row.comment === null ? '—' : row.days),
              },
              {
                key: 'days',
                header: t('utilities.daysTotal'),
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

          {canManage && !closed && rows.length > 0 && (
            <div className="border-border border-t pt-3">
              <DaysForm periodId={periodId} rows={rows} />
            </div>
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

      <History rows={history} />
    </div>
  );
}
