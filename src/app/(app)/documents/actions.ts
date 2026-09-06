'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { tryParseBusinessDate } from '@/lib/time';
import { reviewDocument, submitDocument } from '@/services/documents';

import type { UserActor } from '@/services/users';

/**
 * Действия экрана документов. Байты файла сюда не попадают: их принимает
 * двухшаговая загрузка `/api/v1/files/*` (D4), а server action связывает
 * уже принятый файл с типом документа.
 */
export interface DocumentActionState {
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

function failure(error: unknown): DocumentActionState {
  // Коды ошибок сервисного слоя — это ключи перевода, а не готовый текст.
  return { error: error instanceof AppError ? error.message : 'documents.errors.unknown' };
}

export async function submitDocumentAction(
  _previous: DocumentActionState,
  formData: FormData,
): Promise<DocumentActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'documents.errors.unauthorized' };
  }

  const rawIssueDate = text(formData, 'issueDate');
  const issueDate = rawIssueDate === '' ? null : tryParseBusinessDate(rawIssueDate);

  if (rawIssueDate !== '' && issueDate === null) {
    return { error: 'documents.issueDateInvalid' };
  }

  try {
    await submitDocument(current, {
      residencyId: text(formData, 'residencyId'),
      documentTypeId: text(formData, 'documentTypeId'),
      fileId: text(formData, 'fileId'),
      issueDate,
    });
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/documents');

  return { done: 'documents.submitted' };
}

export async function reviewDocumentAction(
  _previous: DocumentActionState,
  formData: FormData,
): Promise<DocumentActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'documents.errors.unauthorized' };
  }

  const approve = text(formData, 'decision') === 'approve';

  try {
    await reviewDocument(current, text(formData, 'documentId'), {
      approve,
      reason: text(formData, 'reason'),
    });
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/documents');

  return { done: approve ? 'documents.approved' : 'documents.rejected' };
}
