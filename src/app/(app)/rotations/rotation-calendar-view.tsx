'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';

import { Badge, StatusPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { RotationPhotoUpload } from '@/components/upload/rotation-photo-upload';

import {
  cancelOccurrenceAction,
  cancelRangeAction,
  confirmAction,
  createExtraAction,
  markAction,
  moveOccurrenceAction,
  placeAction,
  reassignAction,
  removeAssignmentAction,
  setStatusAction,
  type CalendarActionState,
} from './actions';

const INITIAL: CalendarActionState = {};

export type CalendarMode = 'day' | 'week' | 'month';

export interface AssignmentView {
  assignmentId: string;
  userId: string | null;
  userName: string | null;
  state: 'assigned' | 'needs_reassignment' | 'confirmed' | 'missed' | 'cancelled';
  /** Назначение самого читателя: жилец должен видеть свою ротацию сразу. */
  isMine: boolean;
  /** Оценка 1–10; жильцу не приходит вовсе (§7). */
  score: number | null;
  note: string | null;
  /** Галочка «списать доп. ротацию»: долг −1 при подтверждении (§2.7). */
  writeOffDebt: boolean;
}

export interface OccurrenceCard {
  occurrenceId: string;
  date: string;
  areaName: string;
  checklistTitle: string;
  status: 'scheduled' | 'done' | 'missed' | 'cancelled';
  type: 'regular' | 'room' | 'general' | 'extra';
  movedFromDate: string | null;
  assignments: AssignmentView[];
}

export interface MemberOption {
  userId: string;
  name: string;
}

export interface ZoneOption {
  areaId: string;
  checklistId: string;
  label: string;
}

export interface CalendarProps {
  houseId: string | null;
  canManage: boolean;
  mode: CalendarMode;
  from: string;
  to: string;
  days: { date: string; occurrences: OccurrenceCard[] }[];
  members: readonly MemberOption[];
  zones: readonly ZoneOption[];
}

function Message({ state }: { state: CalendarActionState }) {
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

/** Обновление экрана после действия — календарь открыт со своими параметрами. */
function useRefreshOnDone(state: CalendarActionState): void {
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);
}

/** Одна ротация: зона, чек-лист, исполнители и действия админа. */
function OccurrenceBlock({
  canManage,
  card,
  members,
}: {
  canManage: boolean;
  card: OccurrenceCard;
  members: readonly MemberOption[];
}) {
  const t = useTranslations('rotationCalendar');
  const [moveState, move, isMoving] = useActionState(moveOccurrenceAction, INITIAL);
  const [cancelState, cancel, isCancelling] = useActionState(cancelOccurrenceAction, INITIAL);
  const [assignState, assign, isAssigning] = useActionState(reassignAction, INITIAL);
  const [confirmState, confirm, isConfirming] = useActionState(confirmAction, INITIAL);
  const [markState, mark, isMarking] = useActionState(markAction, INITIAL);
  const [statusState, setStatus, isSettingStatus] = useActionState(setStatusAction, INITIAL);
  const [removeState, remove, isRemoving] = useActionState(removeAssignmentAction, INITIAL);
  const [placeState, place, isPlacing] = useActionState(placeAction, INITIAL);

  useRefreshOnDone(moveState);
  useRefreshOnDone(cancelState);
  useRefreshOnDone(assignState);
  useRefreshOnDone(confirmState);
  useRefreshOnDone(markState);
  useRefreshOnDone(statusState);
  useRefreshOnDone(removeState);
  useRefreshOnDone(placeState);

  /*
   * Снять можно только незакрытое назначение и только не последнее: зону
   * без людей на дату отменяют, а не обнуляют (план фазы 10 §2.6).
   */
  const removable = (assignment: AssignmentView): boolean =>
    canManage &&
    card.status === 'scheduled' &&
    card.assignments.length > 1 &&
    (assignment.state === 'assigned' || assignment.state === 'needs_reassignment');

  return (
    <li
      className="border-border flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0"
      data-testid={`occurrence-${card.occurrenceId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium">
          {card.areaName} · {card.checklistTitle}
        </span>

        <span className="flex items-center gap-2">
          {card.type !== 'regular' && <Badge tone="info">{t(`types.${card.type}`)}</Badge>}
          {card.movedFromDate !== null && <Badge tone="neutral">{t('moved')}</Badge>}
          <StatusPill kind={card.status === 'cancelled' ? 'muted' : 'done'}>
            {t(`statuses.${card.status}`)}
          </StatusPill>
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {card.assignments.map((assignment) => (
          <li
            className="flex flex-wrap items-center gap-2 text-[13px]"
            key={assignment.assignmentId}
          >
            <span className={assignment.isMine ? 'font-medium' : undefined}>
              {assignment.userName ?? t('nobody')}
            </span>

            {assignment.state === 'needs_reassignment' && (
              <Badge tone="warning">{t('needsDecision')}</Badge>
            )}
            {assignment.isMine && <Badge tone="info">{t('mine')}</Badge>}

            {assignment.state === 'confirmed' && (
              <Badge tone="success">{t('confirmedShort')}</Badge>
            )}
            {assignment.state === 'missed' && <Badge tone="danger">{t('missedShort')}</Badge>}
            {assignment.score !== null && (
              <Badge tone="neutral">{t('score', { score: assignment.score })}</Badge>
            )}
            {assignment.writeOffDebt && <Badge tone="info">{t('writeOffBadge')}</Badge>}

            {assignment.isMine && card.status === 'scheduled' && !canManage && (
              <form action={confirm} className="flex flex-wrap items-end gap-2">
                <input name="assignmentId" type="hidden" value={assignment.assignmentId} />
                <Field htmlFor={`done-${assignment.assignmentId}`} label={t('doneAt')}>
                  <Input
                    className="w-52"
                    data-testid={`confirm-done-${assignment.assignmentId}`}
                    id={`done-${assignment.assignmentId}`}
                    name="doneAt"
                    type="datetime-local"
                  />
                </Field>
                <Field htmlFor={`note-${assignment.assignmentId}`} label={t('note')}>
                  <Input
                    className="w-52"
                    data-testid={`confirm-note-${assignment.assignmentId}`}
                    id={`note-${assignment.assignmentId}`}
                    name="note"
                  />
                </Field>
                <RotationPhotoUpload
                  assignmentId={assignment.assignmentId}
                  id={`confirm-photo-${assignment.assignmentId}`}
                />
                <Button
                  data-testid={`confirm-${assignment.assignmentId}`}
                  disabled={isConfirming}
                  size="sm"
                  type="submit"
                >
                  {t('confirm')}
                </Button>
              </form>
            )}

            {canManage && card.status !== 'cancelled' && (
              <form action={mark} className="flex flex-wrap items-end gap-2">
                <input name="assignmentId" type="hidden" value={assignment.assignmentId} />
                <Select
                  className="h-9 w-40"
                  data-testid={`mark-state-${assignment.assignmentId}`}
                  defaultValue={assignment.state === 'missed' ? 'missed' : 'confirmed'}
                  name="state"
                >
                  <option value="confirmed">{t('markDone')}</option>
                  <option value="missed">{t('markMissed')}</option>
                  <option value="assigned">{t('markScheduled')}</option>
                </Select>
                <Input
                  className="w-20"
                  data-testid={`mark-score-${assignment.assignmentId}`}
                  defaultValue={assignment.score ?? ''}
                  max={10}
                  min={1}
                  name="score"
                  placeholder={t('scorePlaceholder')}
                  step={1}
                  type="number"
                />
                <Button
                  data-testid={`mark-${assignment.assignmentId}`}
                  disabled={isMarking}
                  size="sm"
                  type="submit"
                  variant="secondary"
                >
                  {t('mark')}
                </Button>
              </form>
            )}

            {canManage && card.status === 'scheduled' && (
              <form action={assign} className="flex items-center gap-2">
                <input name="assignmentId" type="hidden" value={assignment.assignmentId} />
                <Select
                  className="h-9 w-44"
                  data-testid={`assign-select-${assignment.assignmentId}`}
                  defaultValue={assignment.userId ?? ''}
                  name="userId"
                >
                  <option value="">{t('nobody')}</option>
                  {members.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.name}
                    </option>
                  ))}
                </Select>
                <Button
                  data-testid={`assign-save-${assignment.assignmentId}`}
                  disabled={isAssigning}
                  size="sm"
                  type="submit"
                  variant="ghost"
                >
                  {t('assign')}
                </Button>
              </form>
            )}

            {removable(assignment) && (
              <form action={remove}>
                <input name="assignmentId" type="hidden" value={assignment.assignmentId} />
                <Button
                  data-testid={`remove-${assignment.assignmentId}`}
                  disabled={isRemoving}
                  size="sm"
                  type="submit"
                  variant="ghost"
                >
                  {t('remove')}
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>

      <Message state={assignState} />
      <Message state={confirmState} />
      <Message state={markState} />
      <Message state={removeState} />

      {canManage && card.status === 'scheduled' && (
        <form
          action={place}
          className="flex flex-wrap items-end gap-2"
          data-testid={`place-form-${card.occurrenceId}`}
        >
          <input name="occurrenceId" type="hidden" value={card.occurrenceId} />
          <Field htmlFor={`place-${card.occurrenceId}`} label={t('placeTitle')}>
            <Select
              className="h-9 w-44"
              data-testid={`place-select-${card.occurrenceId}`}
              id={`place-${card.occurrenceId}`}
              name="userId"
              required
            >
              <option value="">{t('placeWho')}</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 pb-2 text-[13px]">
            <input
              className="accent-primary size-4"
              data-testid={`place-writeoff-${card.occurrenceId}`}
              name="writeOffDebt"
              type="checkbox"
            />
            {t('writeOffDebt')}
          </label>
          <Button
            data-testid={`place-save-${card.occurrenceId}`}
            disabled={isPlacing}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {t('place')}
          </Button>
        </form>
      )}

      <Message state={placeState} />

      {canManage && (
        <form action={setStatus} className="flex flex-wrap items-end gap-2">
          <input name="occurrenceId" type="hidden" value={card.occurrenceId} />
          <Select
            className="h-9 w-44"
            data-testid={`status-${card.occurrenceId}`}
            defaultValue={card.status}
            name="status"
          >
            <option value="scheduled">{t('statuses.scheduled')}</option>
            <option value="done">{t('statuses.done')}</option>
            <option value="missed">{t('statuses.missed')}</option>
            <option value="cancelled">{t('statuses.cancelled')}</option>
          </Select>
          <Button
            data-testid={`status-save-${card.occurrenceId}`}
            disabled={isSettingStatus}
            size="sm"
            type="submit"
            variant="ghost"
          >
            {t('setStatus')}
          </Button>
        </form>
      )}

      <Message state={statusState} />

      {canManage && card.status === 'scheduled' && (
        <div className="flex flex-wrap items-end gap-2">
          <form action={move} className="flex items-end gap-2">
            <input name="occurrenceId" type="hidden" value={card.occurrenceId} />
            <Field htmlFor={`move-${card.occurrenceId}`} label={t('moveTo')}>
              <Input
                className="w-40"
                data-testid={`move-date-${card.occurrenceId}`}
                defaultValue={card.date}
                id={`move-${card.occurrenceId}`}
                name="date"
                required
                type="date"
              />
            </Field>
            <Button
              data-testid={`move-save-${card.occurrenceId}`}
              disabled={isMoving}
              size="sm"
              type="submit"
              variant="secondary"
            >
              {t('move')}
            </Button>
          </form>

          <form action={cancel}>
            <input name="occurrenceId" type="hidden" value={card.occurrenceId} />
            <Button
              data-testid={`cancel-${card.occurrenceId}`}
              disabled={isCancelling}
              size="sm"
              type="submit"
              variant="ghost"
            >
              {t('cancel')}
            </Button>
          </form>
        </div>
      )}

      <Message state={moveState} />
      <Message state={cancelState} />
    </li>
  );
}

/** Внеплановая ротация и каникулы — действия над периодом, а не над занятием. */
function PeriodActions({
  from,
  houseId,
  members,
  to,
  zones,
}: {
  from: string;
  houseId: string;
  members: readonly MemberOption[];
  to: string;
  zones: readonly ZoneOption[];
}) {
  const t = useTranslations('rotationCalendar');
  const [extraState, extra, isCreating] = useActionState(createExtraAction, INITIAL);
  const [rangeState, range, isCancelling] = useActionState(cancelRangeAction, INITIAL);

  useRefreshOnDone(extraState);
  useRefreshOnDone(rangeState);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('periodTitle')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-5">
        <form action={extra} className="flex flex-wrap items-end gap-2" data-testid="extra-form">
          <input name="houseId" type="hidden" value={houseId} />

          <div className="w-56">
            <Field htmlFor="extra-zone" label={t('extraZone')}>
              <Select data-testid="extra-zone" id="extra-zone" name="zone" required>
                {zones.map((zone) => (
                  <option
                    key={`${zone.areaId}|${zone.checklistId}`}
                    value={`${zone.areaId}|${zone.checklistId}`}
                  >
                    {zone.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="w-40">
            <Field htmlFor="extra-date" label={t('extraDate')}>
              <Input
                data-testid="extra-date"
                defaultValue={from}
                id="extra-date"
                name="date"
                required
                type="date"
              />
            </Field>
          </div>

          <div className="w-56">
            <Field hint={t('extraWhoHint')} htmlFor="extra-who" label={t('extraWho')}>
              <Select data-testid="extra-who" id="extra-who" name="userIds">
                <option value="">{t('nobody')}</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <label className="flex items-center gap-2 pb-2 text-[13px]">
            <input
              className="accent-primary size-4"
              data-testid="extra-writeoff"
              name="writeOffDebt"
              type="checkbox"
            />
            {t('writeOffDebt')}
          </label>

          <Button data-testid="extra-save" disabled={isCreating} size="sm" type="submit">
            {t('extraCreate')}
          </Button>
        </form>

        <Message state={extraState} />

        <form
          action={range}
          className="border-border flex flex-wrap items-end gap-2 border-t pt-4"
          data-testid="holidays-form"
        >
          <input name="houseId" type="hidden" value={houseId} />

          <div className="w-40">
            <Field htmlFor="holidays-from" label={t('holidaysFrom')}>
              <Input
                data-testid="holidays-from"
                defaultValue={from}
                id="holidays-from"
                name="from"
                required
                type="date"
              />
            </Field>
          </div>

          <div className="w-40">
            <Field htmlFor="holidays-to" label={t('holidaysTo')}>
              <Input
                data-testid="holidays-to"
                defaultValue={to}
                id="holidays-to"
                name="to"
                required
                type="date"
              />
            </Field>
          </div>

          <Button
            data-testid="holidays-cancel"
            disabled={isCancelling}
            size="sm"
            type="submit"
            variant="danger"
          >
            {t('holidaysCancel')}
          </Button>
        </form>

        <Message state={rangeState} />
      </div>
    </Card>
  );
}

export function RotationCalendarView({
  canManage,
  days,
  from,
  houseId,
  members,
  to,
  zones,
}: CalendarProps) {
  const t = useTranslations('rotationCalendar');
  const withOccurrences = days.filter((day) => day.occurrences.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {withOccurrences.length === 0 ? (
        <EmptyState description={t('emptyHint')} title={t('empty')} />
      ) : (
        withOccurrences.map((day) => (
          <Card key={day.date}>
            <CardHeader>
              <CardTitle>{day.date}</CardTitle>
            </CardHeader>

            <ul className="flex flex-col gap-3">
              {day.occurrences.map((card) => (
                <OccurrenceBlock
                  canManage={canManage}
                  card={card}
                  key={card.occurrenceId}
                  members={members}
                />
              ))}
            </ul>
          </Card>
        ))
      )}

      {canManage && houseId !== null && zones.length > 0 && (
        <PeriodActions from={from} houseId={houseId} members={members} to={to} zones={zones} />
      )}
    </div>
  );
}
