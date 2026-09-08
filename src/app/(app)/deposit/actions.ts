'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { actionErrorKey } from '@/lib/action-failure';
import { getCurrentSession } from '@/lib/session';
import { issueDepositInvoice } from '@/services/deposits';
import { recordPayment } from '@/services/invoices';

import type { UserActor } from '@/services/users';

/**
 * Действия экрана депозита. Деньги приходят не через приложение: платёж
 * отмечает тот, кто его получил, — админ дома или суперадмин.
 */
export interface DepositActionState {
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

function failure(error: unknown): DepositActionState {
  return { error: actionErrorKey(error, 'deposit.errors.unknown') };
}

export async function issueDepositInvoiceAction(
  _previous: DepositActionState,
  formData: FormData,
): Promise<DepositActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'deposit.errors.unauthorized' };
  }

  const rawAmount = text(formData, 'amount');
  const amount = rawAmount === '' ? undefined : Number(rawAmount);

  if (amount !== undefined && !Number.isInteger(amount)) {
    return { error: 'deposits.amountInvalid' };
  }

  try {
    await issueDepositInvoice(current, text(formData, 'residencyId'), { amount });
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/deposit');

  return { done: 'deposit.invoiceIssued' };
}

export async function recordPaymentAction(
  _previous: DepositActionState,
  formData: FormData,
): Promise<DepositActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'deposit.errors.unauthorized' };
  }

  const amount = Number(text(formData, 'amount'));
  if (!Number.isInteger(amount) || amount <= 0) {
    return { error: 'deposits.amountInvalid' };
  }

  const method = text(formData, 'method');
  if (method !== 'kaspi' && method !== 'cash') {
    return { error: 'deposit.errors.method' };
  }

  try {
    await recordPayment(current, text(formData, 'invoiceId'), { amount, method });
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/deposit');

  return { done: 'deposit.paymentRecorded' };
}
