'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import {
  archiveAccount,
  createAccount,
  renameAccount,
  type CreatableAccountType,
} from '@/services/chart-of-accounts';

export interface AccountActionState {
  error?: string;
  done?: string;
}

function textField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value.trim() : '';
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
  if (error instanceof ValidationError) {
    return { error: `chartOfAccounts.errors.${error.message}` };
  }

  if (error instanceof AppError) {
    return { error: `chartOfAccounts.errors.${error.code}` };
  }

  throw error;
}

export async function createAccountAction(
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'chartOfAccounts.errors.unauthorized' };
  }

  try {
    await createAccount(actor, {
      code: textField(formData, 'code'),
      name: textField(formData, 'name'),
      type: textField(formData, 'type') as CreatableAccountType,
    });

    revalidatePath('/settings/accounts');

    return { done: 'chartOfAccounts.done.saved' };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function renameAccountAction(
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'chartOfAccounts.errors.unauthorized' };
  }

  try {
    await renameAccount(actor, textField(formData, 'accountId'), textField(formData, 'name'));

    revalidatePath('/settings/accounts');

    return { done: 'chartOfAccounts.done.saved' };
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
    return { error: 'chartOfAccounts.errors.unauthorized' };
  }

  try {
    await archiveAccount(actor, textField(formData, 'accountId'));

    revalidatePath('/settings/accounts');

    return { done: 'chartOfAccounts.done.archived' };
  } catch (error) {
    return toErrorState(error);
  }
}
