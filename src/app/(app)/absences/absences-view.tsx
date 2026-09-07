'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import { Badge, StatusPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select, Textarea } from '@/components/ui/input';

import {
  approveAbsenceAction,
  rejectAbsenceAction,
  submitAbsenceAction,
  type AbsenceActionState,
} from './actions';

const INITIAL: AbsenceActionState = {};

export type AbsenceType = 'short' | 'long' | 'sick';
export type AbsenceStatus = 'pending' | 'approved' | 'rejected';

export interface AbsenceRow {
  absenceId: string;
  type: AbsenceType;
  startDate: string;
  endDate: string | null;
  reason: string;
  status: AbsenceStatus;
  reviewNote: string | null;
  /** Имя жильца: в календаре дома оно нужно, в своём списке — нет. */
  name?: string;
}

export interface AbsencesViewProps {
  mine: readonly AbsenceRow[];
  queue: readonly AbsenceRow[];
  houseCalendar: readonly AbsenceRow[];
  canSubmit: boolean;
  canReview: boolean;
  /** Минимальная дата долгосрочного — завтра (§9). */
  tomorrow: string;
  today: string;
}

function Message({ state }: { state: AbsenceActionState }) {
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

function useRefreshOnDone(state: AbsenceActionState): void {
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);
}

/** Форма подачи: набор полей зависит от типа (§9). */
function SubmitForm({ today, tomorrow }: { today: string; tomorrow: string }) {
  const t = useTranslations('absences');
  const [state, submit, isPending] = useActionState(submitAbsenceAction, INITIAL);
  const [type, setType] = useState<AbsenceType>('short');

  useRefreshOnDone(state);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('submitTitle')}</CardTitle>
      </CardHeader>

      <form action={submit} className="flex flex-col gap-3" data-testid="absence-form">
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-52">
            <Field htmlFor="absence-type" label={t('type')}>
              <Select
                data-testid="absence-type"
                id="absence-type"
                name="type"
                onChange={(event) => {
                  setType(event.target.value as AbsenceType);
                }}
                value={type}
              >
                <option value="short">{t('types.short')}</option>
                <option value="long">{t('types.long')}</option>
                <option value="sick">{t('types.sick')}</option>
              </Select>
            </Field>
          </div>

          <div className="w-44">
            <Field
              hint={type === 'long' ? t('longHint') : undefined}
              htmlFor="absence-start"
              label={t('startDate')}
            >
              <Input
                data-testid="absence-start"
                defaultValue={type === 'long' ? tomorrow : today}
                id="absence-start"
                min={type === 'long' ? tomorrow : undefined}
                name="startDate"
                required
                type="date"
              />
            </Field>
          </div>

          {type !== 'short' && (
            <div className="w-44">
              <Field htmlFor="absence-end" label={t('endDate')}>
                <Input data-testid="absence-end" id="absence-end" name="endDate" type="date" />
              </Field>
            </div>
          )}

          {type === 'short' && (
            <div className="w-52">
              <Field htmlFor="absence-at" label={t('returnAt')}>
                <Input
                  data-testid="absence-at"
                  id="absence-at"
                  name="startAt"
                  type="datetime-local"
                />
              </Field>
            </div>
          )}
        </div>

        <Field hint={t('reasonHint')} htmlFor="absence-reason" label={t('reason')}>
          <Textarea data-testid="absence-reason" id="absence-reason" name="reason" rows={2} />
        </Field>

        <div>
          <Button data-testid="absence-submit" disabled={isPending} size="sm" type="submit">
            {t('submit')}
          </Button>
        </div>

        <Message state={state} />
      </form>
    </Card>
  );
}

/** Строка очереди: одобрить или отклонить с причиной. */
function QueueRow({ row }: { row: AbsenceRow }) {
  const t = useTranslations('absences');
  const [approveState, approve, isApproving] = useActionState(approveAbsenceAction, INITIAL);
  const [rejectState, reject, isRejecting] = useActionState(rejectAbsenceAction, INITIAL);

  useRefreshOnDone(approveState);
  useRefreshOnDone(rejectState);

  return (
    <li
      className="border-border flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0"
      data-testid={`absence-${row.absenceId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span className="font-medium">
          {row.name ?? ''} · {t(`types.${row.type}`)}
        </span>
        <span>
          {row.startDate}
          {row.endDate === null ? '' : ` — ${row.endDate}`}
        </span>
      </div>

      <p className="text-text-muted text-[13px]">{row.reason}</p>

      <div className="flex flex-wrap items-end gap-2">
        <form action={approve}>
          <input name="absenceId" type="hidden" value={row.absenceId} />
          <Button
            data-testid={`absence-approve-${row.absenceId}`}
            disabled={isApproving}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {t('approve')}
          </Button>
        </form>

        <form action={reject} className="flex items-end gap-2">
          <input name="absenceId" type="hidden" value={row.absenceId} />
          <Field htmlFor={`note-${row.absenceId}`} label={t('rejectNote')}>
            <Input
              className="w-52"
              data-testid={`absence-note-${row.absenceId}`}
              id={`note-${row.absenceId}`}
              name="note"
            />
          </Field>
          <Button
            data-testid={`absence-reject-${row.absenceId}`}
            disabled={isRejecting}
            size="sm"
            type="submit"
            variant="ghost"
          >
            {t('reject')}
          </Button>
        </form>
      </div>

      <Message state={approveState} />
      <Message state={rejectState} />
    </li>
  );
}

function StatusBadge({ status }: { status: AbsenceStatus }) {
  const t = useTranslations('absences');

  return (
    <StatusPill kind={status === 'rejected' ? 'muted' : 'done'}>
      {t(`statuses.${status}`)}
    </StatusPill>
  );
}

export function AbsencesView({
  canReview,
  canSubmit,
  houseCalendar,
  mine,
  queue,
  today,
  tomorrow,
}: AbsencesViewProps) {
  const t = useTranslations('absences');

  return (
    <div className="flex flex-col gap-6">
      {canSubmit && <SubmitForm today={today} tomorrow={tomorrow} />}

      {canSubmit && (
        <Card>
          <CardHeader>
            <CardTitle>{t('mineTitle')}</CardTitle>
          </CardHeader>

          {mine.length === 0 ? (
            <EmptyState title={t('mineEmpty')} />
          ) : (
            <ul className="flex flex-col gap-3">
              {mine.map((row) => (
                <li
                  className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-[13px] first:border-t-0 first:pt-0"
                  key={row.absenceId}
                >
                  <span>
                    {t(`types.${row.type}`)} · {row.startDate}
                    {row.endDate === null ? '' : ` — ${row.endDate}`}
                  </span>
                  <span className="flex items-center gap-2">
                    {row.reviewNote !== null && <Badge tone="neutral">{row.reviewNote}</Badge>}
                    <StatusBadge status={row.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {canReview && (
        <Card>
          <CardHeader>
            <CardTitle>{t('queueTitle')}</CardTitle>
          </CardHeader>

          {queue.length === 0 ? (
            <EmptyState title={t('queueEmpty')} />
          ) : (
            <ul className="flex flex-col gap-3" data-testid="absence-queue">
              {queue.map((row) => (
                <QueueRow key={row.absenceId} row={row} />
              ))}
            </ul>
          )}
        </Card>
      )}

      {canReview && (
        <Card>
          <CardHeader>
            <CardTitle>{t('calendarTitle')}</CardTitle>
          </CardHeader>

          {houseCalendar.length === 0 ? (
            <EmptyState title={t('calendarEmpty')} />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="absence-calendar">
              {houseCalendar.map((row) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 text-[13px]"
                  key={row.absenceId}
                >
                  <span>
                    {row.name ?? ''} · {t(`types.${row.type}`)}
                  </span>
                  <span className="flex items-center gap-2">
                    <span>
                      {row.startDate}
                      {row.endDate === null ? '' : ` — ${row.endDate}`}
                    </span>
                    <StatusBadge status={row.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
