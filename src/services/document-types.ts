import { getDb, type Executor } from '@/db/client';
import {
  createDocumentType as insertDocumentType,
  findDocumentTypeByCode,
  listDocumentTypes as selectDocumentTypes,
  requireDocumentType,
  updateDocumentType as patchDocumentType,
} from '@/db/repositories/documents';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { LOCALES } from '@/lib/i18n/config';
import { now } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { DocumentType } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Типы документов сети (модуль 11, «Настройки сети»; T8.2).
 *
 * До этого экрана типы заводил только сид, и сеть без него было нечем
 * восстановить. Правит их суперадмин: срок годности документа — это правило
 * всей сети, а не одного дома.
 *
 * Удаления нет. На тип ссылаются уже загруженные документы, и удалить его
 * значило бы стереть смысл чужого файла; архивация убирает тип из списка
 * и оставляет историю читаемой.
 */
export interface DocumentTypeInput {
  code: string;
  nameI18n: Record<string, string>;
  validityMonths: number | null;
  requiresIssueDate: boolean;
  isRequired: boolean;
  sortOrder: number;
}

/** Код уходит в путь хранения `/{house}/{residency}/{document_type}/`. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

const MAX_VALIDITY_MONTHS = 120;

function assertCode(code: string): void {
  if (!CODE_PATTERN.test(code)) {
    throw new ValidationError('codeInvalid', { code });
  }
}

function assertNames(nameI18n: Record<string, string>): void {
  const missing = LOCALES.filter((locale) => (nameI18n[locale] ?? '').trim() === '');

  if (missing.length > 0) {
    throw new ValidationError('nameRequired', { locales: missing });
  }
}

function assertValidity(months: number | null): void {
  if (months === null) {
    return;
  }

  if (!Number.isInteger(months) || months < 1 || months > MAX_VALIDITY_MONTHS) {
    throw new ValidationError('validityInvalid', { months });
  }
}

export async function listDocumentTypes(
  actor: UserActor,
  options: { includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<DocumentType[]> {
  assertCan(actor.context, 'settings.org.read');

  return selectDocumentTypes(actor.context, options, executor);
}

export async function createDocumentType(
  actor: UserActor,
  input: DocumentTypeInput,
  executor: Executor = getDb(),
): Promise<DocumentType> {
  assertCan(actor.context, 'settings.org.write');

  const code = input.code.trim();
  assertCode(code);
  assertNames(input.nameI18n);
  assertValidity(input.validityMonths);

  const existing = await findDocumentTypeByCode(actor.context, code, executor);
  if (existing !== null) {
    throw new ValidationError('codeTaken', { code });
  }

  return executor.transaction(async (tx) => {
    const created = await insertDocumentType(
      actor.context,
      {
        code,
        nameI18n: input.nameI18n,
        validityMonths: input.validityMonths,
        requiresIssueDate: input.requiresIssueDate,
        isRequired: input.isRequired,
        sortOrder: input.sortOrder,
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.documentTypeSaved,
        entityType: 'document_type',
        entityId: created.id,
        after: { ...created },
      },
      tx,
    );

    return created;
  });
}

/**
 * Правка типа. Код не меняется: он записан в путях уже загруженных файлов,
 * и переименование кода оставило бы документы без типа.
 */
export async function updateDocumentType(
  actor: UserActor,
  documentTypeId: string,
  patch: Partial<Omit<DocumentTypeInput, 'code'>>,
  executor: Executor = getDb(),
): Promise<DocumentType> {
  assertCan(actor.context, 'settings.org.write');

  if (patch.nameI18n !== undefined) {
    assertNames(patch.nameI18n);
  }

  if (patch.validityMonths !== undefined) {
    assertValidity(patch.validityMonths);
  }

  const before = await requireDocumentType(actor.context, documentTypeId, executor);

  return executor.transaction(async (tx) => {
    const updated = await patchDocumentType(actor.context, documentTypeId, patch, tx);
    if (updated === null) {
      throw new NotFoundError('Тип документа не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.documentTypeSaved,
        entityType: 'document_type',
        entityId: documentTypeId,
        before: { ...before },
        after: { ...updated },
      },
      tx,
    );

    return updated;
  });
}

export async function archiveDocumentType(
  actor: UserActor,
  documentTypeId: string,
  executor: Executor = getDb(),
): Promise<DocumentType> {
  assertCan(actor.context, 'settings.org.write');

  const before = await requireDocumentType(actor.context, documentTypeId, executor);

  return executor.transaction(async (tx) => {
    const updated = await patchDocumentType(
      actor.context,
      documentTypeId,
      { archivedAt: now() },
      tx,
    );

    if (updated === null) {
      throw new NotFoundError('Тип документа не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.documentTypeArchived,
        entityType: 'document_type',
        entityId: documentTypeId,
        before: { archivedAt: before.archivedAt },
        after: { archivedAt: updated.archivedAt },
      },
      tx,
    );

    return updated;
  });
}
