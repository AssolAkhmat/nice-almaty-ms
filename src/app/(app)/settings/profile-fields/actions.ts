'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { PROFILE_FIELD_TYPES, type ProfileFieldType } from '@/domain/profile-fields';
import { AppError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { archiveDeclaration, declareField, updateDeclaration } from '@/services/profile-fields';

export interface ProfileFieldActionState {
  error?: string;
  errorParams?: Record<string, string>;
  done?: string;
}

function textField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value.trim() : '';
}

/** Варианты выбора вводятся построчно: так их правят, а не пересобирают. */
function optionsFrom(formData: FormData): string[] {
  return textField(formData, 'options')
    .split('\n')
    .map((option) => option.trim())
    .filter((option) => option !== '');
}

function typeFrom(formData: FormData): ProfileFieldType {
  const raw = textField(formData, 'type');

  return PROFILE_FIELD_TYPES.includes(raw as ProfileFieldType) ? (raw as ProfileFieldType) : 'text';
}

function namesFrom(formData: FormData): Record<string, string> {
  return {
    ru: textField(formData, 'nameRu'),
    kk: textField(formData, 'nameKk'),
    en: textField(formData, 'nameEn'),
  };
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

/**
 * Сообщение проверки — ключ перевода, а подробности идут подстановками:
 * «код занят» и «варианты повторяются» должны читаться по-разному, а код
 * у всех проверок один (`validation_error`).
 */
function toErrorState(error: unknown): ProfileFieldActionState {
  if (error instanceof ValidationError) {
    return {
      error: `profile.fieldErrors.${error.message}`,
      errorParams: Object.fromEntries(
        Object.entries(error.details ?? {}).map(([key, value]) => [key, String(value)]),
      ),
    };
  }

  if (error instanceof AppError) {
    return { error: `profileFields.errors.${error.code}` };
  }

  throw error;
}

export async function declareFieldAction(
  _previous: ProfileFieldActionState,
  formData: FormData,
): Promise<ProfileFieldActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'profileFields.errors.unauthorized' };
  }

  try {
    await declareField(actor, {
      code: textField(formData, 'code'),
      nameI18n: namesFrom(formData),
      type: typeFrom(formData),
      isRequired: formData.get('isRequired') !== null,
      options: optionsFrom(formData),
      sortOrder: Number(textField(formData, 'sortOrder') || '0'),
    });

    revalidatePath('/settings/profile-fields');
    revalidatePath('/profile');

    return { done: 'profileFields.done.saved' };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function updateFieldAction(
  _previous: ProfileFieldActionState,
  formData: FormData,
): Promise<ProfileFieldActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'profileFields.errors.unauthorized' };
  }

  try {
    await updateDeclaration(actor, textField(formData, 'fieldId'), {
      nameI18n: namesFrom(formData),
      isRequired: formData.get('isRequired') !== null,
      options: optionsFrom(formData),
      sortOrder: Number(textField(formData, 'sortOrder') || '0'),
    });

    revalidatePath('/settings/profile-fields');
    revalidatePath('/profile');

    return { done: 'profileFields.done.saved' };
  } catch (error) {
    return toErrorState(error);
  }
}

/**
 * Архивация и возврат из архива одним действием: ошибочно архивированное
 * поле возвращают, а не заводят заново под другим кодом — код занят навсегда.
 */
export async function archiveFieldAction(
  _previous: ProfileFieldActionState,
  formData: FormData,
): Promise<ProfileFieldActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'profileFields.errors.unauthorized' };
  }

  const archived = textField(formData, 'archived') !== 'false';

  try {
    await archiveDeclaration(actor, textField(formData, 'fieldId'), archived);

    revalidatePath('/settings/profile-fields');
    revalidatePath('/profile');

    return { done: archived ? 'profileFields.done.archived' : 'profileFields.done.restored' };
  } catch (error) {
    return toErrorState(error);
  }
}
