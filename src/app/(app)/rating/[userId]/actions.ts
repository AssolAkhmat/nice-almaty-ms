'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { addRatingEvent, approveDiscount, cancelFine } from '@/services/rating';

export interface RatingEventActionState {
  error?: string;
  done?: string;
}

async function actorOf() {
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

function text(formData: FormData, key: string): string {
  const value = formData.get(key);

  return typeof value === 'string' ? value.trim() : '';
}

/** Действие админа: тип, причина и комментарий (модуль 8). */
export async function addRatingEventAction(
  _previous: RatingEventActionState,
  formData: FormData,
): Promise<RatingEventActionState> {
  const actor = await actorOf();

  if (actor === null) {
    return { error: 'unauthorized' };
  }

  const userId = text(formData, 'userId');
  const note = text(formData, 'note');

  try {
    await addRatingEvent(actor, {
      userId,
      type: text(formData, 'type'),
      reason: text(formData, 'reason'),
      ...(note === '' ? {} : { note }),
    });

    revalidatePath(`/rating/${userId}`);

    return { done: 'eventAdded' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: error.code };
    }

    throw error;
  }
}

export async function cancelFineAction(
  _previous: RatingEventActionState,
  formData: FormData,
): Promise<RatingEventActionState> {
  const actor = await actorOf();

  if (actor === null) {
    return { error: 'unauthorized' };
  }

  const userId = text(formData, 'userId');

  try {
    await cancelFine(actor, text(formData, 'fineId'), text(formData, 'reason'));

    revalidatePath(`/rating/${userId}`);

    return { done: 'fineCancelled' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: error.code };
    }

    throw error;
  }
}

export async function approveDiscountAction(
  _previous: RatingEventActionState,
  formData: FormData,
): Promise<RatingEventActionState> {
  const actor = await actorOf();

  if (actor === null) {
    return { error: 'unauthorized' };
  }

  const userId = text(formData, 'userId');

  try {
    await approveDiscount(actor, text(formData, 'discountId'));

    revalidatePath(`/rating/${userId}`);

    return { done: 'discountApproved' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: error.code };
    }

    throw error;
  }
}
