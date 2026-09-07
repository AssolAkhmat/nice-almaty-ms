'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { tryParseBusinessDate } from '@/lib/time';
import {
  archiveResidency,
  createRefundInvoice,
  settleRefund,
  terminateResidency,
} from '@/services/terminations';
import { changeAccountRole } from '@/services/users';

import type { UserActor } from '@/services/users';

/** Смена роли отдельным действием (модуль 1, долг фазы 1). */
export interface RoleActionState {
  error?: string;
  done?: string;
}

/** Расторжение договора и разбор депозита (§2.2–2.3). */
export interface TerminationActionState {
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

export async function changeRoleAction(
  _previous: RoleActionState,
  formData: FormData,
): Promise<RoleActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'residents.errors.unauthorized' };
  }

  const role = text(formData, 'role');
  if (role !== 'resident' && role !== 'admin') {
    return { error: 'residents.errors.role' };
  }

  const houseId = text(formData, 'houseId');

  try {
    await changeAccountRole(
      current,
      text(formData, 'userId'),
      role,
      houseId === '' ? null : houseId,
    );
  } catch (error) {
    return {
      error: error instanceof AppError ? error.message : 'residents.errors.unknown',
    };
  }

  revalidatePath('/residents');

  return { done: 'residents.roleChanged' };
}

function terminationFailure(error: unknown): TerminationActionState {
  return { error: error instanceof AppError ? error.message : 'terminations.errors.unknown' };
}

/**
 * Карточка жильца лежит под списком, а депозит и дэшборд показывают то же
 * состояние. Обновляется вся ветка: иначе экран остался бы с прежним видом
 * до перезагрузки руками.
 */
function refreshResident(): void {
  revalidatePath('/residents', 'layout');
  revalidatePath('/deposit');
  revalidatePath('/');
}

/** Расторжение: дата выезда и причина — оба поля модалки обязательны. */
export async function terminateResidencyAction(
  _previous: TerminationActionState,
  formData: FormData,
): Promise<TerminationActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'terminations.errors.unauthorized' };
  }

  const moveOutDate = tryParseBusinessDate(text(formData, 'moveOutDate'));
  if (moveOutDate === null) {
    return { error: 'terminations.errors.moveOutDate.invalid' };
  }

  try {
    await terminateResidency(current, text(formData, 'residencyId'), {
      moveOutDate,
      reason: text(formData, 'reason'),
    });
  } catch (error) {
    return terminationFailure(error);
  }

  refreshResident();

  return { done: 'terminations.terminated' };
}

export async function createRefundInvoiceAction(
  _previous: TerminationActionState,
  formData: FormData,
): Promise<TerminationActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'terminations.errors.unauthorized' };
  }

  try {
    const invoice = await createRefundInvoice(current, text(formData, 'residencyId'));
    refreshResident();

    // Возвращать нечего — это результат расчёта, а не отказ: счёта просто нет (§2.4).
    return {
      done: invoice === null ? 'terminations.nothingToRefund' : 'terminations.refundIssued',
    };
  } catch (error) {
    return terminationFailure(error);
  }
}

export async function settleRefundAction(
  _previous: TerminationActionState,
  formData: FormData,
): Promise<TerminationActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'terminations.errors.unauthorized' };
  }

  try {
    await settleRefund(current, text(formData, 'invoiceId'), {});
  } catch (error) {
    return terminationFailure(error);
  }

  refreshResident();

  return { done: 'terminations.refunded' };
}

export async function archiveResidencyAction(
  _previous: TerminationActionState,
  formData: FormData,
): Promise<TerminationActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'terminations.errors.unauthorized' };
  }

  try {
    await archiveResidency(current, text(formData, 'residencyId'));
  } catch (error) {
    return terminationFailure(error);
  }

  refreshResident();

  return { done: 'terminations.archived' };
}
