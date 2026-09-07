'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { issueApiToken, revokeToken } from '@/services/api-tokens';

import type { UserActor } from '@/services/users';

/**
 * Токены API (docs/06-API.md, «Аутентификация»).
 *
 * Значение возвращается ровно один раз — в ответе на выдачу. Ни в списке,
 * ни в базе его нет: там только хеш, и показать его снова неоткуда.
 */
export interface TokenActionState {
  error?: string;
  done?: string;
  /** Значение выданного токена. Живёт только в этом ответе. */
  value?: string;
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

function failure(error: unknown): TokenActionState {
  return { error: error instanceof AppError ? error.message : 'apiTokens.errors.unknown' };
}

export async function issueTokenAction(
  _previous: TokenActionState,
  formData: FormData,
): Promise<TokenActionState> {
  const user = await actor();

  if (user === null) {
    return { error: 'apiTokens.errors.unknown' };
  }

  const scopes = formData
    .getAll('scopes')
    .filter((value): value is string => typeof value === 'string');
  const houseId = text(formData, 'houseId');

  try {
    const issued = await issueApiToken(user, {
      name: text(formData, 'name'),
      scopes,
      ...(houseId === '' ? {} : { houseId }),
    });

    revalidatePath('/settings/api-tokens');

    return { done: 'apiTokens.issued', value: issued.value };
  } catch (error) {
    return failure(error);
  }
}

export async function revokeTokenAction(
  _previous: TokenActionState,
  formData: FormData,
): Promise<TokenActionState> {
  const user = await actor();

  if (user === null) {
    return { error: 'apiTokens.errors.unknown' };
  }

  try {
    await revokeToken(user, text(formData, 'tokenId'));
    revalidatePath('/settings/api-tokens');

    return { done: 'apiTokens.revoked' };
  } catch (error) {
    return failure(error);
  }
}
