'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { actionErrorKey } from '@/lib/action-failure';
import { AppError, ConflictError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { createDamage, reverseDamage } from '@/services/damages';

import type { DamageSplitMode } from '@/domain/damage';
import type { UserActor } from '@/services/users';

/** Ущерб: проведение и сторно (docs/04-MODULES/07-damages.md). */
export interface DamageActionState {
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

/**
 * Ошибки проверок несут готовый ключ перевода, остальные — только код:
 * «Не найдено» и «Действие недоступно» приходят из общего слоя прав
 * и человеческого текста в себе не носят.
 */
function failure(error: unknown): DamageActionState {
  if (error instanceof ValidationError || error instanceof ConflictError) {
    return { error: error.message };
  }

  if (error instanceof AppError) {
    return { error: `damages.errors.${error.code}` };
  }

  return { error: actionErrorKey(error, 'damages.errors.unknown') };
}

/** Списание касается депозитов, поэтому обновляется и экран депозита. */
function refresh(): void {
  revalidatePath('/damages');
  revalidatePath('/deposit');
  revalidatePath('/residents', 'layout');
}

export async function createDamageAction(
  _previous: DamageActionState,
  formData: FormData,
): Promise<DamageActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'damages.errors.unauthorized' };
  }

  const amount = Number(text(formData, 'amount'));
  const areaId = text(formData, 'areaId');
  const description = text(formData, 'description');
  const receiptFileId = text(formData, 'receiptFileId');

  const userIds = formData
    .getAll('userIds')
    .filter((value): value is string => typeof value === 'string');

  try {
    await createDamage(current, {
      houseId: text(formData, 'houseId'),
      title: text(formData, 'title'),
      description: description === '' ? null : description,
      amount,
      splitMode: text(formData, 'splitMode') as DamageSplitMode,
      userIds,
      areaId: areaId === '' ? null : areaId,
      receiptFileId: receiptFileId === '' ? null : receiptFileId,
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'damages.done.created' };
}

export async function reverseDamageAction(
  _previous: DamageActionState,
  formData: FormData,
): Promise<DamageActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'damages.errors.unauthorized' };
  }

  try {
    await reverseDamage(current, text(formData, 'damageId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'damages.done.reversed' };
}
