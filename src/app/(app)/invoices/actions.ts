'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { actionErrorKey } from '@/lib/action-failure';
import { AppError, ConflictError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { startOfDayUtc, tryParseBusinessDate } from '@/lib/time';
import {
  cancelInvoice,
  createInvoice,
  editInvoiceLines,
  recalculateInvoice,
  recordPayment,
  type InvoiceLineInput,
} from '@/services/invoices';

import type { InvoiceLineKind } from '@/domain/invoice';
import type { UserActor } from '@/services/users';

/** Счета: создание, правка строк, пересчёт, отмена и платежи (модуль 2). */
export interface InvoiceActionState {
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

function all(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((value): value is string => typeof value === 'string');
}

/**
 * Строки приходят тремя параллельными списками: вид, название, сумма.
 * Форма добавляет их по одной, и порядок в списках — порядок в форме.
 */
function linesFrom(formData: FormData): InvoiceLineInput[] {
  const kinds = all(formData, 'lineKind');
  const titles = all(formData, 'lineTitle');
  const amounts = all(formData, 'lineAmount');

  return kinds.map((kind, index) => ({
    kind: kind as InvoiceLineKind,
    title: titles[index] ?? '',
    amount: Number(amounts[index] ?? ''),
  }));
}

function failure(error: unknown): InvoiceActionState {
  if (error instanceof ValidationError || error instanceof ConflictError) {
    return { error: error.message };
  }

  if (error instanceof AppError) {
    return { error: `invoices.errors.${error.code}` };
  }

  return { error: actionErrorKey(error, 'invoices.errors.unknown') };
}

/** Счёт виден и на своём экране, и на депозите, и на дэшборде. */
function refresh(): void {
  revalidatePath('/invoices', 'layout');
  revalidatePath('/deposit');
  revalidatePath('/');
}

export async function createInvoiceAction(
  _previous: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'invoices.errors.unauthorized' };
  }

  const periodMonth = tryParseBusinessDate(text(formData, 'periodMonth'));
  const dueDate = tryParseBusinessDate(text(formData, 'dueDate'));
  const note = text(formData, 'note');
  const type = text(formData, 'type') === 'extra' ? 'extra' : 'monthly';

  try {
    await createInvoice(current, {
      residencyId: text(formData, 'residencyId'),
      type,
      ...(periodMonth === null ? {} : { periodMonth }),
      ...(dueDate === null ? {} : { dueDate }),
      note: note === '' ? null : note,
      lines: linesFrom(formData),
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'invoices.done.created' };
}

export async function editInvoiceLinesAction(
  _previous: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'invoices.errors.unauthorized' };
  }

  try {
    await editInvoiceLines(current, text(formData, 'invoiceId'), linesFrom(formData));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'invoices.done.edited' };
}

export async function recalculateInvoiceAction(
  _previous: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'invoices.errors.unauthorized' };
  }

  try {
    await recalculateInvoice(current, text(formData, 'invoiceId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'invoices.done.recalculated' };
}

export async function cancelInvoiceAction(
  _previous: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'invoices.errors.unauthorized' };
  }

  try {
    await cancelInvoice(current, text(formData, 'invoiceId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'invoices.done.cancelled' };
}

export async function recordInvoicePaymentAction(
  _previous: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'invoices.errors.unauthorized' };
  }

  const method = text(formData, 'method');
  if (method !== 'kaspi' && method !== 'cash') {
    return { error: 'invoices.errors.method' };
  }

  const note = text(formData, 'note');
  const paidAt = tryParseBusinessDate(text(formData, 'paidAt'));

  try {
    await recordPayment(current, text(formData, 'invoiceId'), {
      amount: Number(text(formData, 'amount')),
      method,
      // Пустая дата — момент отметки: деньги обычно принимают тем же днём.
      ...(paidAt === null ? {} : { paidAt: startOfDayUtc(paidAt) }),
      ...(note === '' ? {} : { note }),
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'invoices.done.paymentRecorded' };
}
