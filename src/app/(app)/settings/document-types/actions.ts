'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import {
  archiveDocumentType,
  createDocumentType,
  updateDocumentType,
} from '@/services/document-types';

export interface DocumentTypeActionState {
  error?: string;
  done?: string;
}

function textField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value.trim() : '';
}

function monthsField(formData: FormData): number | null {
  const raw = textField(formData, 'validityMonths');

  return raw === '' ? null : Number(raw);
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
 * Сообщение проверки — само по себе ключ перевода: «код занят» и «название
 * пустое» должны читаться по-разному, а код у всех проверок один
 * (`validation_error`).
 */
function toErrorState(error: unknown): DocumentTypeActionState {
  if (error instanceof ValidationError) {
    return { error: `documentTypes.errors.${error.message}` };
  }

  if (error instanceof AppError) {
    return { error: `documentTypes.errors.${error.code}` };
  }

  throw error;
}

function namesFrom(formData: FormData): Record<string, string> {
  return {
    ru: textField(formData, 'nameRu'),
    kk: textField(formData, 'nameKk'),
    en: textField(formData, 'nameEn'),
  };
}

export async function createDocumentTypeAction(
  _previous: DocumentTypeActionState,
  formData: FormData,
): Promise<DocumentTypeActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'documentTypes.errors.unauthorized' };
  }

  try {
    await createDocumentType(actor, {
      code: textField(formData, 'code'),
      nameI18n: namesFrom(formData),
      validityMonths: monthsField(formData),
      requiresIssueDate: formData.get('requiresIssueDate') !== null,
      isRequired: formData.get('isRequired') !== null,
      sortOrder: Number(textField(formData, 'sortOrder') || '0'),
    });

    revalidatePath('/settings/document-types');

    return { done: 'documentTypes.done.saved' };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function updateDocumentTypeAction(
  _previous: DocumentTypeActionState,
  formData: FormData,
): Promise<DocumentTypeActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'documentTypes.errors.unauthorized' };
  }

  try {
    await updateDocumentType(actor, textField(formData, 'documentTypeId'), {
      nameI18n: namesFrom(formData),
      validityMonths: monthsField(formData),
      requiresIssueDate: formData.get('requiresIssueDate') !== null,
      isRequired: formData.get('isRequired') !== null,
      sortOrder: Number(textField(formData, 'sortOrder') || '0'),
    });

    revalidatePath('/settings/document-types');

    return { done: 'documentTypes.done.saved' };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function archiveDocumentTypeAction(
  _previous: DocumentTypeActionState,
  formData: FormData,
): Promise<DocumentTypeActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'documentTypes.errors.unauthorized' };
  }

  try {
    await archiveDocumentType(actor, textField(formData, 'documentTypeId'));

    revalidatePath('/settings/document-types');

    return { done: 'documentTypes.done.archived' };
  } catch (error) {
    return toErrorState(error);
  }
}
