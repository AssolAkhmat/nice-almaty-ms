'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError, ConflictError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { tryParseBusinessDate } from '@/lib/time';
import { recordExpense } from '@/services/accounting';
import { reverseEntry } from '@/services/ledger';

import type { UserActor } from '@/services/users';

/** Бухгалтерия: расходы и сторно проводок (модуль 10). */
export interface AccountingActionState {
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

function failure(error: unknown): AccountingActionState {
  if (error instanceof ValidationError || error instanceof ConflictError) {
    return { error: error.message };
  }

  if (error instanceof AppError) {
    return { error: `accounting.errors.${error.code}` };
  }

  return { error: 'accounting.errors.unknown' };
}

export async function recordExpenseAction(
  _previous: AccountingActionState,
  formData: FormData,
): Promise<AccountingActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'accounting.errors.unauthorized' };
  }

  const date = tryParseBusinessDate(text(formData, 'date'));
  const paidFrom = text(formData, 'paidFrom');
  const receiptFileId = text(formData, 'receiptFileId');

  try {
    await recordExpense(current, {
      category: text(formData, 'category'),
      amount: Number(text(formData, 'amount')),
      description: text(formData, 'description'),
      accountId: text(formData, 'accountId'),
      paidFrom: paidFrom === 'kaspi' ? 'kaspi' : 'cash',
      receiptFileId: receiptFileId === '' ? null : receiptFileId,
      ...(date === null ? {} : { date }),
    });
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/accounting');

  return { done: 'accounting.done.expense' };
}

export async function reverseEntryAction(
  _previous: AccountingActionState,
  formData: FormData,
): Promise<AccountingActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'accounting.errors.unauthorized' };
  }

  try {
    await reverseEntry(current, text(formData, 'entryId'));
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/accounting');

  return { done: 'accounting.done.reversed' };
}
