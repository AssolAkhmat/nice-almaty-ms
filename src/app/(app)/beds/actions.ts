'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { tryParseBusinessDate } from '@/lib/time';
import { assignBedToResidency } from '@/services/beds';

import type { UserActor } from '@/services/users';

/** Назначение места жильцу: комната, место, цена и дата начала (§1.2 п.4). */
export interface BedActionState {
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

export async function assignBedAction(
  _previous: BedActionState,
  formData: FormData,
): Promise<BedActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'beds.errors.unauthorized' };
  }

  const rawPrice = text(formData, 'price');
  const price = rawPrice === '' ? undefined : Number(rawPrice);
  if (price !== undefined && !Number.isInteger(price)) {
    return { error: 'beds.priceInvalid' };
  }

  const rawFrom = text(formData, 'from');
  const from = rawFrom === '' ? undefined : tryParseBusinessDate(rawFrom);
  if (rawFrom !== '' && from === undefined) {
    return { error: 'beds.errors.date' };
  }

  try {
    await assignBedToResidency(current, {
      residencyId: text(formData, 'residencyId'),
      bedId: text(formData, 'bedId'),
      price,
      from: from ?? undefined,
    });
  } catch (error) {
    return {
      error: error instanceof AppError ? error.message : 'beds.errors.unknown',
    };
  }

  revalidatePath('/beds');

  return { done: 'beds.assigned' };
}
