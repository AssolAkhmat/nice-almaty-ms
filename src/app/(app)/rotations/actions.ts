'use server';

import { headers } from 'next/headers';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { tryParseBusinessDate } from '@/lib/time';
import {
  cancelOccurrence,
  cancelRange,
  createExtraOccurrence,
  moveOccurrence,
  reassignAssignment,
} from '@/services/rotation-calendar';

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
