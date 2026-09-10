'use server';

import { headers } from 'next/headers';

import { actionErrorKey } from '@/lib/action-failure';
import { getCurrentSession } from '@/lib/session';
import { cancelOccurrence, placeOnOccurrence, swapAssignments } from '@/services/rotation-calendar';

import type { UserActor } from '@/services/users';

/**
 * Решения по дыркам расписания с дэшборда админа (`docs/tasks/PHASE-10.md` §2.8).
 *
 * Здесь нет своей логики: каждое действие — та же правка недели, что
 * и в календаре, только выбранная из вариантов, которые система предложила.
 */
export interface HoleActionState {
  error?: string;
  done?: string;
}

async function actor(): Promise<UserActor | null> {
  const session = await getCurrentSession();
  if (session === null) {
    return null;
  }

  const store = await headers();

  return {
    context: session.context,
    ip: store.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
  };
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value.trim() : '';
}

function failure(error: unknown): HoleActionState {
  return { error: actionErrorKey(error, 'rotationCalendar.errors.unknown') };
}

export async function placeHoleAction(
  _previous: HoleActionState,
  formData: FormData,
): Promise<HoleActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  const userId = text(formData, 'userId');
  if (userId === '') {
    return { error: 'rotationCalendar.errors.whoRequired' };
  }

  try {
    await placeOnOccurrence(user, {
      occurrenceId: text(formData, 'occurrenceId'),
      assignmentId: text(formData, 'assignmentId'),
      userId,
      writeOffDebt: text(formData, 'writeOffDebt') === 'on',
    });
  } catch (error) {
    return failure(error);
  }

  return { done: 'home.admin.holePlaced' };
}

export async function swapHoleAction(
  _previous: HoleActionState,
  formData: FormData,
): Promise<HoleActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  const replacement = text(formData, 'replacementUserId');

  try {
    await swapAssignments(user, {
      holeAssignmentId: text(formData, 'holeAssignmentId'),
      moverAssignmentId: text(formData, 'moverAssignmentId'),
      replacementUserId: replacement === '' ? null : replacement,
      writeOffDebt: text(formData, 'writeOffDebt') === 'on',
    });
  } catch (error) {
    return failure(error);
  }

  return { done: 'home.admin.holeSwapped' };
}

export async function cancelHoleAction(
  _previous: HoleActionState,
  formData: FormData,
): Promise<HoleActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  try {
    await cancelOccurrence(user, text(formData, 'occurrenceId'));
  } catch (error) {
    return failure(error);
  }

  return { done: 'home.admin.holeCancelled' };
}
