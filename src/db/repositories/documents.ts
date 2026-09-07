import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { getDb, type Executor } from '../client';
import {
  documents,
  documentTypes,
  residencies,
  type DocumentRecord,
  type DocumentType,
  type NewDocumentRecord,
  type NewDocumentType,
} from '../schema';
import { residencyVisibility } from './residencies';

import type { AccessContext } from '../access';

/**
 * Типы документов и загруженные документы.
 *
 * Типы принадлежат сети и видны всем её пользователям: жилец обязан знать,
 * что от него требуется. Сами документы видны через проживание — тем же
 * правилом, что файлы и профиль (P2-5).
 */
function typeScope(context: AccessContext) {
  return eq(documentTypes.orgId, context.orgId);
}

function documentScope(context: AccessContext, executor: Executor) {
  return and(
    eq(documents.orgId, context.orgId),
    inArray(
      documents.residencyId,
      executor.select({ id: residencies.id }).from(residencies).where(residencyVisibility(context)),
    ),
  );
}

export async function listDocumentTypes(
  context: AccessContext,
  options: { includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<DocumentType[]> {
  const conditions = [typeScope(context)];
  if (options.includeArchived !== true) {
    conditions.push(isNull(documentTypes.archivedAt));
  }

  return executor
    .select()
    .from(documentTypes)
    .where(and(...conditions))
    .orderBy(asc(documentTypes.sortOrder), asc(documentTypes.code), asc(documentTypes.id));
}

export async function findDocumentTypeByCode(
  context: AccessContext,
  code: string,
  executor: Executor = getDb(),
): Promise<DocumentType | null> {
  const [type] = await executor
    .select()
    .from(documentTypes)
    .where(and(typeScope(context), eq(documentTypes.code, code)))
    .limit(1);

  return type ?? null;
}

export async function requireDocumentType(
  context: AccessContext,
  documentTypeId: string,
  executor: Executor = getDb(),
): Promise<DocumentType> {
  const [type] = await executor
    .select()
    .from(documentTypes)
    .where(and(typeScope(context), eq(documentTypes.id, documentTypeId)))
    .limit(1);

  if (type === undefined) {
    throw new NotFoundError('Тип документа не найден');
  }

  return type;
}

export async function createDocumentType(
  context: AccessContext,
  input: Omit<NewDocumentType, 'orgId'>,
  executor: Executor = getDb(),
): Promise<DocumentType> {
  const [type] = await executor
    .insert(documentTypes)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (type === undefined) {
    throw new Error('Тип документа не создан');
  }

  return type;
}

/** Статус выставляет сервис: новый документ всегда `uploaded`. */
export type DocumentInput = Omit<
  NewDocumentRecord,
  'orgId' | 'status' | 'reviewedBy' | 'reviewedAt'
>;

export async function createDocument(
  context: AccessContext,
  input: DocumentInput,
  executor: Executor = getDb(),
): Promise<DocumentRecord> {
  const [document] = await executor
    .insert(documents)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (document === undefined) {
    throw new Error('Документ не создан');
  }

  return document;
}

export async function listDocuments(
  context: AccessContext,
  filter: { residencyId?: string; status?: DocumentRecord['status'] } = {},
  executor: Executor = getDb(),
): Promise<DocumentRecord[]> {
  const conditions = [documentScope(context, executor)];

  if (filter.residencyId !== undefined) {
    conditions.push(eq(documents.residencyId, filter.residencyId));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(documents.status, filter.status));
  }

  return executor
    .select()
    .from(documents)
    .where(and(...conditions))
    .orderBy(asc(documents.createdAt), asc(documents.id));
}

export async function findDocument(
  context: AccessContext,
  documentId: string,
  executor: Executor = getDb(),
): Promise<DocumentRecord | null> {
  const [document] = await executor
    .select()
    .from(documents)
    .where(and(documentScope(context, executor), eq(documents.id, documentId)))
    .limit(1);

  return document ?? null;
}

export async function requireDocument(
  context: AccessContext,
  documentId: string,
  executor: Executor = getDb(),
): Promise<DocumentRecord> {
  const document = await findDocument(context, documentId, executor);
  if (document === null) {
    throw new NotFoundError('Документ не найден');
  }

  return document;
}

export async function updateDocument(
  context: AccessContext,
  documentId: string,
  patch: Partial<Omit<NewDocumentRecord, 'id' | 'orgId' | 'residencyId' | 'userId'>>,
  executor: Executor = getDb(),
): Promise<DocumentRecord | null> {
  const [document] = await executor
    .update(documents)
    .set({ ...patch, updatedAt: now() })
    .where(and(documentScope(context, executor), eq(documents.id, documentId)))
    .returning();

  return document ?? null;
}
