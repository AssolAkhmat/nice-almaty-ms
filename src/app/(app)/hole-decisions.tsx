'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/input';

import {
  cancelHoleAction,
  placeHoleAction,
  swapHoleAction,
  type HoleActionState,
} from './dashboard-actions';

import type { CandidateSource } from '@/domain/rotation-day';
import type { DecisionCandidate, HoleDecision } from '@/services/rotation-decisions';

const INITIAL: HoleActionState = {};

function Message({ state }: { state: HoleActionState }) {
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

function useRefreshOnDone(state: HoleActionState): void {
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);
}

/**
 * Кандидаты группами в порядке §6.3: с долгом, отдыхающие в этот день, остальные.
 * Недопущенный не прячется, а помечается: админ вправе знать, кого система
 * не советует и почему (§2.8).
 */
function CandidateOptions({ candidates }: { candidates: readonly DecisionCandidate[] }) {
  const t = useTranslations('home.admin');
  const groups: [CandidateSource, string][] = [
    ['debt', t('holeGroupDebt')],
    ['resting', t('holeGroupResting')],
    ['resident', t('holeGroupOthers')],
  ];

  const label = (candidate: DecisionCandidate): string => {
    const notes: string[] = [];

    if (candidate.source === 'debt') {
      notes.push(t('holeDebt', { count: candidate.debt }));
    }
    if (!candidate.eligible) {
      notes.push(t('holeNotEligible'));
    }
    if (candidate.busyAreaNames.length > 0) {
      notes.push(t('holeBusy', { areas: candidate.busyAreaNames.join(', ') }));
    }

    return notes.length === 0 ? candidate.name : `${candidate.name} (${notes.join(', ')})`;
  };

  return (
    <>
      {groups.map(([source, title]) => {
        const items = candidates.filter((candidate) => candidate.source === source);

        if (items.length === 0) {
          return null;
        }

        return (
          <optgroup key={source} label={title}>
            {items.map((candidate) => (
              <option key={candidate.userId} value={candidate.userId}>
                {label(candidate)}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

/** Одна дырка: причина, кого поставить, обмен в один ход, отмена зоны на дату. */
function HoleItem({ hole }: { hole: HoleDecision }) {
  const t = useTranslations('home.admin');
  const tReason = useTranslations('rotationDaySetup.holes');
  const tCalendar = useTranslations('rotationCalendar');
  const [placeState, place, isPlacing] = useActionState(placeHoleAction, INITIAL);
  const [swapState, swap, isSwapping] = useActionState(swapHoleAction, INITIAL);
  const [cancelState, cancel, isCancelling] = useActionState(cancelHoleAction, INITIAL);
  const [moverId, setMoverId] = useState(hole.swaps[0]?.moverAssignmentId ?? '');

  useRefreshOnDone(placeState);
  useRefreshOnDone(swapState);
  useRefreshOnDone(cancelState);

  const chosenSwap =
    hole.swaps.find((option) => option.moverAssignmentId === moverId) ?? hole.swaps[0];

  return (
    <li
      className="border-border flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0"
      data-testid={`hole-${hole.assignmentId}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium">
          {hole.date} · {hole.areaName} · {hole.checklistTitle}
        </span>
        <Badge tone="warning">{tReason(hole.reason)}</Badge>
        {hole.queuedName !== null && (
          <span className="text-text-muted">{t('holeQueued', { name: hole.queuedName })}</span>
        )}
      </div>

      <form
        action={place}
        className="flex flex-wrap items-end gap-2"
        data-testid={`hole-place-${hole.assignmentId}`}
      >
        <input name="assignmentId" type="hidden" value={hole.assignmentId} />
        <input name="occurrenceId" type="hidden" value={hole.occurrenceId} />
        <Field htmlFor={`hole-who-${hole.assignmentId}`} label={t('holeWho')}>
          <Select
            className="h-9 w-56"
            data-testid={`hole-who-${hole.assignmentId}`}
            id={`hole-who-${hole.assignmentId}`}
            name="userId"
            required
          >
            <option value="">{t('holeWho')}</option>
            <CandidateOptions candidates={hole.candidates} />
          </Select>
        </Field>
        <label className="flex items-center gap-2 pb-2 text-[13px]">
          <input
            className="accent-primary size-4"
            data-testid={`hole-writeoff-${hole.assignmentId}`}
            name="writeOffDebt"
            type="checkbox"
          />
          {tCalendar('writeOffDebt')}
        </label>
        <Button
          data-testid={`hole-put-${hole.assignmentId}`}
          disabled={isPlacing}
          size="sm"
          type="submit"
        >
          {t('holePut')}
        </Button>
      </form>
      <Message state={placeState} />

      {chosenSwap !== undefined && (
        <form
          action={swap}
          className="flex flex-wrap items-end gap-2"
          data-testid={`hole-swap-${hole.assignmentId}`}
        >
          <input name="holeAssignmentId" type="hidden" value={hole.assignmentId} />
          <Field htmlFor={`hole-mover-${hole.assignmentId}`} label={t('holeSwapWho')}>
            <Select
              className="h-9 w-56"
              id={`hole-mover-${hole.assignmentId}`}
              name="moverAssignmentId"
              onChange={(event) => setMoverId(event.target.value)}
              value={chosenSwap.moverAssignmentId}
            >
              {hole.swaps.map((option) => (
                <option key={option.moverAssignmentId} value={option.moverAssignmentId}>
                  {t('holeSwapOption', { name: option.name, area: option.fromAreaName })}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            htmlFor={`hole-replacement-${hole.assignmentId}`}
            label={t('holeReplacement', { area: chosenSwap.fromAreaName })}
          >
            <Select
              className="h-9 w-56"
              defaultValue=""
              id={`hole-replacement-${hole.assignmentId}`}
              key={chosenSwap.moverAssignmentId}
              name="replacementUserId"
            >
              <option value="">{t('holeLeaveOpen')}</option>
              <CandidateOptions candidates={chosenSwap.replacements} />
            </Select>
          </Field>
          <label className="flex items-center gap-2 pb-2 text-[13px]">
            <input
              className="accent-primary size-4"
              data-testid={`hole-swap-writeoff-${hole.assignmentId}`}
              name="writeOffDebt"
              type="checkbox"
            />
            {tCalendar('writeOffDebt')}
          </label>
          <Button
            data-testid={`hole-swap-apply-${hole.assignmentId}`}
            disabled={isSwapping}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {t('holeApplySwap')}
          </Button>
        </form>
      )}
      <Message state={swapState} />

      <form action={cancel}>
        <input name="occurrenceId" type="hidden" value={hole.occurrenceId} />
        <Button
          data-testid={`hole-cancel-${hole.assignmentId}`}
          disabled={isCancelling}
          size="sm"
          type="submit"
          variant="ghost"
        >
          {t('holeCancel')}
        </Button>
      </form>
      <Message state={cancelState} />
    </li>
  );
}

/**
 * Дырки расписания с вариантами (`docs/tasks/PHASE-10.md` §2.8).
 *
 * Система предлагает, админ решает: каждый выбор — обычная правка недели,
 * та же, что в календаре. Само предложение ничего не сохраняет.
 */
export function HoleDecisions({ holes }: { holes: readonly HoleDecision[] }) {
  return (
    <ul className="flex flex-col gap-3" data-testid="hole-list">
      {holes.map((hole) => (
        <HoleItem hole={hole} key={hole.assignmentId} />
      ))}
    </ul>
  );
}
