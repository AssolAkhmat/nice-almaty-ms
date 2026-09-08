'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { actionErrorKey } from '@/lib/action-failure';
import { getCurrentSession } from '@/lib/session';
import {
  archiveHouseArea,
  archiveHouseBed,
  createHouseArea,
  createHouseBed,
  updateHouseArea,
  updateHouseBed,
} from '@/services/house-setup';

import type { UserActor } from '@/services/users';

/**
 * Настройка дома: зоны, места и цены по умолчанию
 * (docs/04-MODULES/02-places-and-payments.md, «Настройка дома»).
 */
export interface HouseSetupActionState {
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

function failure(error: unknown): HouseSetupActionState {
  return { error: actionErrorKey(error, 'houseSetup.errors.unknown') };
}

function refresh(): void {
  revalidatePath('/settings/house');
  // Схема дома читает те же зоны и места: без этого она осталась бы прежней.
  revalidatePath('/beds');
}

export async function createAreaAction(
  _previous: HouseSetupActionState,
  formData: FormData,
): Promise<HouseSetupActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'houseSetup.errors.unauthorized' };
  }

  const type = text(formData, 'type');
  if (type !== 'living' && type !== 'common') {
    return { error: 'houseSetup.errors.typeInvalid' };
  }

  const rawOrder = text(formData, 'sortOrder');
  const sortOrder = rawOrder === '' ? undefined : Number(rawOrder);
  if (sortOrder !== undefined && !Number.isInteger(sortOrder)) {
    return { error: 'houseSetup.errors.sortOrderInvalid' };
  }

  try {
    await createHouseArea(current, text(formData, 'houseId'), {
      name: text(formData, 'name'),
      type,
      ...(sortOrder === undefined ? {} : { sortOrder }),
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'houseSetup.areaCreated' };
}

export async function updateAreaAction(
  _previous: HouseSetupActionState,
  formData: FormData,
): Promise<HouseSetupActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'houseSetup.errors.unauthorized' };
  }

  const rawOrder = text(formData, 'sortOrder');
  const sortOrder = rawOrder === '' ? undefined : Number(rawOrder);
  if (sortOrder !== undefined && !Number.isInteger(sortOrder)) {
    return { error: 'houseSetup.errors.sortOrderInvalid' };
  }

  try {
    await updateHouseArea(current, text(formData, 'areaId'), {
      name: text(formData, 'name'),
      ...(sortOrder === undefined ? {} : { sortOrder }),
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'houseSetup.areaUpdated' };
}

export async function archiveAreaAction(
  _previous: HouseSetupActionState,
  formData: FormData,
): Promise<HouseSetupActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'houseSetup.errors.unauthorized' };
  }

  try {
    await archiveHouseArea(current, text(formData, 'areaId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'houseSetup.areaArchived' };
}

function bedFields(formData: FormData): {
  label: string;
  number: number;
  tier: 'upper' | 'lower';
  defaultPrice: number;
} | null {
  const tier = text(formData, 'tier');
  if (tier !== 'upper' && tier !== 'lower') {
    return null;
  }

  const number = Number(text(formData, 'number'));
  const defaultPrice = Number(text(formData, 'defaultPrice'));

  if (!Number.isInteger(number) || !Number.isInteger(defaultPrice)) {
    return null;
  }

  return { label: text(formData, 'label'), number, tier, defaultPrice };
}

export async function createBedAction(
  _previous: HouseSetupActionState,
  formData: FormData,
): Promise<HouseSetupActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'houseSetup.errors.unauthorized' };
  }

  const fields = bedFields(formData);
  if (fields === null) {
    return { error: 'houseSetup.errors.bedFields' };
  }

  try {
    await createHouseBed(current, text(formData, 'areaId'), fields);
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'houseSetup.bedCreated' };
}

export async function updateBedAction(
  _previous: HouseSetupActionState,
  formData: FormData,
): Promise<HouseSetupActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'houseSetup.errors.unauthorized' };
  }

  const fields = bedFields(formData);
  if (fields === null) {
    return { error: 'houseSetup.errors.bedFields' };
  }

  try {
    await updateHouseBed(current, text(formData, 'bedId'), fields);
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'houseSetup.bedUpdated' };
}

export async function archiveBedAction(
  _previous: HouseSetupActionState,
  formData: FormData,
): Promise<HouseSetupActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'houseSetup.errors.unauthorized' };
  }

  try {
    await archiveHouseBed(current, text(formData, 'bedId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'houseSetup.bedArchived' };
}
