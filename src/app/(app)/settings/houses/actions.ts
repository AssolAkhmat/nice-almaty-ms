'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { archiveHouse, createHouse, updateHouse } from '@/services/houses';

export interface HouseActionState {
  error?: string;
  done?: string;
}

function textField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value : '';
}

function numberField(formData: FormData, name: string): number | undefined {
  const raw = textField(formData, name).trim();

  return raw === '' ? undefined : Number(raw);
}

async function actorFromSession() {
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

function toErrorState(error: unknown): HouseActionState {
  if (error instanceof AppError) {
    return { error: `houses.errors.${error.code}` };
  }

  if (error instanceof RangeError) {
    return { error: 'houses.errors.validation_error' };
  }

  throw error;
}

function inputFrom(formData: FormData) {
  return {
    name: textField(formData, 'name'),
    address: textField(formData, 'address') || null,
    curfewTime: textField(formData, 'curfewTime') || undefined,
    defaultDeposit: numberField(formData, 'defaultDeposit'),
  };
}

export async function createHouseAction(
  _previous: HouseActionState,
  formData: FormData,
): Promise<HouseActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'houses.errors.unauthorized' };
  }

  try {
    await createHouse(actor, inputFrom(formData));
    revalidatePath('/settings/houses');

    return { done: 'houses.done.created' };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function updateHouseAction(
  _previous: HouseActionState,
  formData: FormData,
): Promise<HouseActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'houses.errors.unauthorized' };
  }

  try {
    await updateHouse(actor, textField(formData, 'houseId'), inputFrom(formData));
    revalidatePath('/settings/houses');

    return { done: 'houses.done.updated' };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function archiveHouseAction(
  _previous: HouseActionState,
  formData: FormData,
): Promise<HouseActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'houses.errors.unauthorized' };
  }

  try {
    await archiveHouse(actor, textField(formData, 'houseId'));
    revalidatePath('/settings/houses');

    return { done: 'houses.done.archived' };
  } catch (error) {
    return toErrorState(error);
  }
}
