'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { actionErrorKey } from '@/lib/action-failure';
import { getCurrentSession } from '@/lib/session';
import { tryParseBusinessDate, type BusinessDate } from '@/lib/time';
import { assignBedToResidency } from '@/services/beds';
import { addTemporary, editTemporary, removeTemporary } from '@/services/temporary-residents';

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
      error: actionErrorKey(error, 'beds.errors.unknown'),
    };
  }

  revalidatePath('/beds');

  return { done: 'beds.assigned' };
}

/** Временные жильцы для ротаций (T11.3): заводятся на «Схеме мест» (D23). */
export interface TemporaryActionState {
  error?: string;
  done?: string;
}

function period(formData: FormData): { from: BusinessDate; to: BusinessDate | null } | null {
  const from = tryParseBusinessDate(text(formData, 'from'));

  if (from === null) {
    return null;
  }

  const rawTo = text(formData, 'to');
  const to = rawTo === '' ? null : tryParseBusinessDate(rawTo);

  if (rawTo !== '' && to === null) {
    return null;
  }

  return { from, to };
}

function sexOf(formData: FormData): 'male' | 'female' | null {
  const value = text(formData, 'sex');

  return value === 'male' || value === 'female' ? value : null;
}

export async function addTemporaryAction(
  _previous: TemporaryActionState,
  formData: FormData,
): Promise<TemporaryActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'beds.errors.unauthorized' };
  }

  const range = period(formData);
  const sex = sexOf(formData);

  if (range === null) {
    return { error: 'beds.errors.date' };
  }

  /* Пол обязателен: на нём держатся фильтры допуска «парни» и «девушки» (D23). */
  if (sex === null) {
    return { error: 'temporaryResidents.errors.sexRequired' };
  }

  try {
    await addTemporary(current, {
      houseId: text(formData, 'houseId'),
      bedId: text(formData, 'bedId'),
      name: text(formData, 'name'),
      sex,
      period: range,
      note: text(formData, 'note') === '' ? null : text(formData, 'note'),
    });
  } catch (error) {
    return { error: actionErrorKey(error, 'temporaryResidents.errors.unknown') };
  }

  refreshRotations();

  return { done: 'temporaryResidents.added' };
}

export async function editTemporaryAction(
  _previous: TemporaryActionState,
  formData: FormData,
): Promise<TemporaryActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'beds.errors.unauthorized' };
  }

  const range = period(formData);
  const sex = sexOf(formData);

  if (range === null || sex === null) {
    return { error: 'beds.errors.date' };
  }

  try {
    await editTemporary(current, text(formData, 'id'), {
      name: text(formData, 'name'),
      sex,
      period: range,
      note: text(formData, 'note') === '' ? null : text(formData, 'note'),
    });
  } catch (error) {
    return { error: actionErrorKey(error, 'temporaryResidents.errors.unknown') };
  }

  refreshRotations();

  return { done: 'temporaryResidents.updated' };
}

export async function removeTemporaryAction(
  _previous: TemporaryActionState,
  formData: FormData,
): Promise<TemporaryActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'beds.errors.unauthorized' };
  }

  try {
    await removeTemporary(current, text(formData, 'id'));
  } catch (error) {
    return { error: actionErrorKey(error, 'temporaryResidents.errors.unknown') };
  }

  refreshRotations();

  return { done: 'temporaryResidents.removed' };
}

/** Временный жилец стоит в ряду ротаций, поэтому обновляется и расписание. */
function refreshRotations(): void {
  revalidatePath('/beds');
  revalidatePath('/rotations', 'layout');
}
