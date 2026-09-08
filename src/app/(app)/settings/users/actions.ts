'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import {
  allowPasswordReset,
  archiveAccount,
  createAccount,
  openResidencyForAccount,
} from '@/services/users';

/**
 * Действия над учётными записями. Права проверяет сервисный слой
 * через `authz.ts`; экран прав не знает и знать не должен (CLAUDE.md §3).
 */
export interface AccountActionState {
  /** Ключ i18n. */
  error?: string;
  /** Показывается один раз: в базе только хеш. */
  temporaryPassword?: string;
  createdPhone?: string;
  done?: string;
}

function textField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value : '';
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

function toErrorState(error: unknown): AccountActionState {
  if (error instanceof AppError) {
    return { error: `users.errors.${error.code}` };
  }

  throw error;
}

export async function createAccountAction(
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'users.errors.unauthorized' };
  }

  const role = textField(formData, 'role');
  if (role !== 'admin' && role !== 'resident' && role !== 'superadmin') {
    return { error: 'users.errors.validation_error' };
  }

  try {
    const created = await createAccount(actor, {
      phone: textField(formData, 'phone'),
      role,
      houseId: textField(formData, 'houseId') || null,
    });

    revalidatePath('/settings/users');

    return { temporaryPassword: created.temporaryPassword, createdPhone: created.user.phone };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function allowPasswordResetAction(
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'users.errors.unauthorized' };
  }

  try {
    await allowPasswordReset(actor, textField(formData, 'userId'));
    revalidatePath('/settings/users');

    return { done: 'users.done.resetAllowed' };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function archiveAccountAction(
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'users.errors.unauthorized' };
  }

  try {
    await archiveAccount(actor, textField(formData, 'userId'));
    revalidatePath('/settings/users');

    return { done: 'users.done.archived' };
  } catch (error) {
    return toErrorState(error);
  }
}

/** Проживание для админа, заведённого до P9-3: без него ему не назначить место. */
export async function openResidencyAction(
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'users.errors.unauthorized' };
  }

  try {
    await openResidencyForAccount(actor, textField(formData, 'userId'));
    revalidatePath('/settings/users');
    // Схема мест и список жильцов дома читают проживания: без этого админ там не появится.
    revalidatePath('/beds');
    revalidatePath('/residents');

    return { done: 'users.done.residencyOpened' };
  } catch (error) {
    return toErrorState(error);
  }
}
