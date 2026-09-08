'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { actionErrorKey } from '@/lib/action-failure';
import { getCurrentSession } from '@/lib/session';
import { buildContract, markKeysIssued, signContract } from '@/services/contracts';

import type { UserActor } from '@/services/users';

/**
 * Действия экрана договора. PNG подписи сюда не попадает: он уже принят
 * двухшаговой загрузкой, и действие получает только идентификатор файла.
 */
export interface ContractActionState {
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

function failure(error: unknown): ContractActionState {
  return { error: actionErrorKey(error, 'contract.errors.unknown') };
}

export async function buildContractAction(
  _previous: ContractActionState,
  formData: FormData,
): Promise<ContractActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'contract.errors.unauthorized' };
  }

  try {
    await buildContract(current, text(formData, 'residencyId'));
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/contract');

  return { done: 'contract.built' };
}

export async function signContractAction(
  _previous: ContractActionState,
  formData: FormData,
): Promise<ContractActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'contract.errors.unauthorized' };
  }

  try {
    await signContract(current, text(formData, 'residencyId'), text(formData, 'signatureFileId'));
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/contract');

  return { done: 'contract.signed' };
}

export async function issueKeysAction(
  _previous: ContractActionState,
  formData: FormData,
): Promise<ContractActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'contract.errors.unauthorized' };
  }

  try {
    await markKeysIssued(current, text(formData, 'residencyId'));
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/contract');

  return { done: 'contract.keysIssued' };
}
