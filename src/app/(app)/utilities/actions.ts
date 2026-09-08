'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { actionErrorKey } from '@/lib/action-failure';
import { AppError, ConflictError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { tryParseBusinessDate } from '@/lib/time';
import {
  addPeriodLine,
  closeUtilityPeriod,
  openUtilityPeriod,
  removePeriodLine,
  reopenUtilityPeriod,
} from '@/services/utilities';

import type { UserActor } from '@/services/users';

/** Коммунальный период: строки, закрытие, переоткрытие (модуль 6). */
export interface UtilityActionState {
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

function failure(error: unknown): UtilityActionState {
  if (error instanceof ValidationError || error instanceof ConflictError) {
    return { error: error.message };
  }

  if (error instanceof AppError) {
    return { error: `utilities.errors.${error.code}` };
  }

  return { error: actionErrorKey(error, 'utilities.errors.unknown') };
}

/** Доли уходят в счета, поэтому обновляется и раздел счетов. */
function refresh(): void {
  revalidatePath('/utilities');
  revalidatePath('/invoices', 'layout');
}

export async function openPeriodAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  const month = tryParseBusinessDate(text(formData, 'month'));
  if (month === null) {
    return { error: 'utilities.errors.month' };
  }

  try {
    await openUtilityPeriod(current, text(formData, 'houseId'), month);
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.opened' };
}

export async function addLineAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  try {
    const receiptFileId = text(formData, 'receiptFileId');

    await addPeriodLine(current, text(formData, 'periodId'), {
      title: text(formData, 'title'),
      amount: Number(text(formData, 'amount')),
      receiptFileId: receiptFileId === '' ? null : receiptFileId,
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.lineAdded' };
}

export async function removeLineAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  try {
    await removePeriodLine(current, text(formData, 'lineId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.lineRemoved' };
}

export async function closePeriodAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  try {
    await closeUtilityPeriod(current, text(formData, 'periodId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.closed' };
}

export async function reopenPeriodAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  try {
    await reopenUtilityPeriod(current, text(formData, 'periodId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.reopened' };
}
