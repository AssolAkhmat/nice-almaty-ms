'use server';

import { headers } from 'next/headers';

import { actionErrorKey } from '@/lib/action-failure';
import { getCurrentSession } from '@/lib/session';
import { parseInstant, tryParseBusinessDate } from '@/lib/time';
import { approveAbsence, rejectAbsence, submitAbsence } from '@/services/absences';

import type { UserActor } from '@/services/users';

/**
 * Отсутствия (docs/04-MODULES/05-presence.md).
 *
 * Экран обновляет клиент по завершении действия: страница открывается
 * ссылками с параметрами, а кеш маршрутизатора ключуется вместе с ними.
 */
export interface AbsenceActionState {
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

function failure(error: unknown): AbsenceActionState {
  return { error: actionErrorKey(error, 'absences.errors.unknown') };
}

/** Время возвращения приходит из `datetime-local` — без зоны, читается по Алматы. */
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

export async function submitAbsenceAction(
  _previous: AbsenceActionState,
  formData: FormData,
): Promise<AbsenceActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'absences.errors.unknown' };
  }

  const rawType = text(formData, 'type');
  const type = rawType === 'long' ? 'long' : rawType === 'sick' ? 'sick' : 'short';

  const startDate = tryParseBusinessDate(text(formData, 'startDate'));
  if (startDate === null) {
    return { error: 'absences.errors.startRequired' };
  }

  const endDate = tryParseBusinessDate(text(formData, 'endDate'));
  const startAt = instantOf(text(formData, 'startAt'));
  const docFileId = text(formData, 'docFileId');

  try {
    await submitAbsence(user, {
      type,
      startDate,
      ...(endDate === null ? {} : { endDate }),
      ...(startAt === null ? {} : { startAt }),
      reason: text(formData, 'reason'),
      ...(docFileId === '' ? {} : { docFileId }),
    });
  } catch (error) {
    return failure(error);
  }

  return { done: 'absences.submitted' };
}

export async function approveAbsenceAction(
  _previous: AbsenceActionState,
  formData: FormData,
): Promise<AbsenceActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'absences.errors.unknown' };
  }

  try {
    await approveAbsence(user, text(formData, 'absenceId'));
  } catch (error) {
    return failure(error);
  }

  return { done: 'absences.approved' };
}

export async function rejectAbsenceAction(
  _previous: AbsenceActionState,
  formData: FormData,
): Promise<AbsenceActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'absences.errors.unknown' };
  }

  try {
    await rejectAbsence(user, text(formData, 'absenceId'), text(formData, 'note'));
  } catch (error) {
    return failure(error);
  }

  return { done: 'absences.rejected' };
}
