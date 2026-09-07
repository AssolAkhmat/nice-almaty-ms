'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError, ConflictError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { recordPayment } from '@/services/invoices';
import { markInvoiceSent } from '@/services/remote';

import type { UserActor } from '@/services/users';

/** «Удалёнка»: отметка отправки счёта и полученного перевода (§3.1). */
export interface RemoteActionState {
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

function failure(error: unknown): RemoteActionState {
  if (error instanceof ValidationError || error instanceof ConflictError) {
    return { error: error.message };
  }

  if (error instanceof AppError) {
    return { error: `invoices.errors.${error.code}` };
  }

  return { error: 'invoices.errors.unknown' };
}

function refresh(): void {
  revalidatePath('/invoices', 'layout');
  revalidatePath('/');
}

export async function markSentAction(
  _previous: RemoteActionState,
  formData: FormData,
): Promise<RemoteActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'invoices.errors.unauthorized' };
  }

  try {
    await markInvoiceSent(current, text(formData, 'invoiceId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'invoices.remote.done.sent' };
}

/**
 * «Оплата получена» закрывает остаток одним платежом через Kaspi:
 * перевод приходит целиком, а частичную оплату отмечают на карточке счёта.
 */
export async function markReceivedAction(
  _previous: RemoteActionState,
  formData: FormData,
): Promise<RemoteActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'invoices.errors.unauthorized' };
  }

  try {
    await recordPayment(current, text(formData, 'invoiceId'), {
      amount: Number(text(formData, 'amount')),
      method: 'kaspi',
      note: 'Перевод Kaspi (удалёнка)',
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'invoices.remote.done.received' };
}
