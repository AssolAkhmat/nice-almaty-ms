'use server';

import { headers } from 'next/headers';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { parseInstant, tryParseBusinessDate } from '@/lib/time';
import {
  cancelOccurrence,
  cancelRange,
  createExtraOccurrence,
  moveOccurrence,
  reassignAssignment,
} from '@/services/rotation-calendar';
import {
  confirmAssignment,
  markAssignment,
  setOccurrenceStatus,
} from '@/services/rotation-confirmation';

import type { UserActor } from '@/services/users';

/**
 * Действия календаря ротаций (docs/03-BUSINESS-RULES.md §6.6).
 *
 * Экран обновляет клиент по завершении действия: страница открывается
 * ссылками с параметрами режима и даты, а кеш маршрутизатора ключуется
 * вместе с ними (запись в docs/tasks/MAINTENANCE.md).
 */
export interface CalendarActionState {
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

function list(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => value !== '');
}

function failure(error: unknown): CalendarActionState {
  return { error: error instanceof AppError ? error.message : 'rotationCalendar.errors.unknown' };
}

export async function moveOccurrenceAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  const date = tryParseBusinessDate(text(formData, 'date'));
  if (date === null) {
    return { error: 'rotationCalendar.errors.dateInvalid' };
  }

  try {
    await moveOccurrence(user, text(formData, 'occurrenceId'), date);
  } catch (error) {
    return failure(error);
  }

  return { done: 'rotationCalendar.moved_done' };
}

export async function cancelOccurrenceAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  try {
    await cancelOccurrence(user, text(formData, 'occurrenceId'));
  } catch (error) {
    return failure(error);
  }

  return { done: 'rotationCalendar.cancelled' };
}

export async function reassignAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  const userId = text(formData, 'userId');

  try {
    await reassignAssignment(user, text(formData, 'assignmentId'), userId === '' ? null : userId);
  } catch (error) {
    return failure(error);
  }

  return { done: 'rotationCalendar.reassigned' };
}

export async function createExtraAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  const date = tryParseBusinessDate(text(formData, 'date'));
  if (date === null) {
    return { error: 'rotationCalendar.errors.dateInvalid' };
  }

  const [areaId = '', checklistId = ''] = text(formData, 'zone').split('|');

  try {
    await createExtraOccurrence(user, {
      houseId: text(formData, 'houseId'),
      areaId,
      checklistId,
      date,
      userIds: list(formData, 'userIds'),
    });
  } catch (error) {
    return failure(error);
  }

  return { done: 'rotationCalendar.extraCreated' };
}

export async function cancelRangeAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  const from = tryParseBusinessDate(text(formData, 'from'));
  const to = tryParseBusinessDate(text(formData, 'to'));

  if (from === null || to === null) {
    return { error: 'rotationCalendar.errors.dateInvalid' };
  }

  try {
    await cancelRange(user, text(formData, 'houseId'), { from, to });
  } catch (error) {
    return failure(error);
  }

  return { done: 'rotationCalendar.rangeCancelled' };
}

/**
 * Момент из поля `datetime-local`: браузер присылает его без зоны, а считаем
 * мы по Алматы (§0), поэтому смещение дописывается явно.
 */
function instantOf(value: string): Date | null {
  if (value === '') {
    return null;
  }

  try {
    return parseInstant(`${value}:00+05:00`);
  } catch {
    return null;
  }
}

export async function confirmAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  const doneAt = instantOf(text(formData, 'doneAt'));
  const note = text(formData, 'note');

  try {
    await confirmAssignment(user, text(formData, 'assignmentId'), {
      ...(doneAt === null ? {} : { doneAt }),
      ...(note === '' ? {} : { note }),
      ...(list(formData, 'photoFileIds').length === 0
        ? {}
        : { photoFileIds: list(formData, 'photoFileIds') }),
    });
  } catch (error) {
    return failure(error);
  }

  return { done: 'rotationCalendar.confirmed' };
}

export async function markAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  const state = text(formData, 'state');
  const rawScore = text(formData, 'score');

  try {
    await markAssignment(user, text(formData, 'assignmentId'), {
      state: state === 'missed' ? 'missed' : state === 'assigned' ? 'assigned' : 'confirmed',
      ...(rawScore === '' ? {} : { score: Number(rawScore) }),
    });
  } catch (error) {
    return failure(error);
  }

  return { done: 'rotationCalendar.marked' };
}

export async function setStatusAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  const status = text(formData, 'status');
  const known = ['scheduled', 'done', 'missed', 'cancelled'] as const;

  if (!(known as readonly string[]).includes(status)) {
    return { error: 'rotationCalendar.errors.unknown' };
  }

  try {
    await setOccurrenceStatus(
      user,
      text(formData, 'occurrenceId'),
      status as (typeof known)[number],
    );
  } catch (error) {
    return failure(error);
  }

  return { done: 'rotationCalendar.statusChanged' };
}
