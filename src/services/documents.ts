import { getDb, type Executor } from '@/db/client';
import {
  createDocument,
  listDocuments,
  listDocumentTypes,
  requireDocument,
  requireDocumentType,
  updateDocument,
} from '@/db/repositories/documents';
import { requireFile } from '@/db/repositories/files';
import { requireResidency } from '@/db/repositories/residencies';
import {
  checkDocumentDates,
  documentPeriod,
  documentValidity,
  daysUntilExpiry,
  type DocumentValidity,
} from '@/domain/documents';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { now, parseBusinessDate, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { DocumentRecord, DocumentType } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Документы жильца (docs/04-MODULES/01-onboarding.md, §1.3).
 *
 * Сроки годности считает расчётное ядро `src/domain/documents.ts`; здесь —
 * права, связь с файлом и журнал. Принять или отклонить справку может только
 * админ дома или суперадмин: жильцу это действие закрыто матрицей прав.
 */
export interface DocumentDeps {
  executor?: Executor;
  /** «Сегодня» приходит извне: сервис не смотрит на часы сам. */
  today?: BusinessDate;
}

export interface SubmitDocumentInput {
  residencyId: string;
  documentTypeId: string;
  fileId: string;
  /** Дата выдачи; для флюорографии — дата снимка, и она обязательна. */
  issueDate: BusinessDate | null;
}

export interface ReviewDecision {
  approve: boolean;
  /** Причина обязательна при отклонении: жильцу нужно знать, что исправить. */
  reason?: string | undefined;
}

/** Карточка типа документа для экрана: что требуется и что уже загружено. */
export interface DocumentCard {
  type: DocumentType;
  document: DocumentRecord | null;
  validity: DocumentValidity | null;
  daysLeft: number | null;
}

function resolve(deps: DocumentDeps): { executor: Executor; today: BusinessDate } {
  return { executor: deps.executor ?? getDb(), today: deps.today ?? todayInAlmaty() };
}

/** Права на документ берутся у проживания, к которому он прикреплён. */
async function assertDocumentAccess(
  actor: UserActor,
  action: 'document.upload' | 'document.review',
  residencyId: string,
  executor: Executor,
): Promise<void> {
  const residency = await requireResidency(actor.context, residencyId, executor);

  assertCan(actor.context, action, { houseId: residency.houseId, userId: residency.userId });
}

/**
 * Последний документ каждого типа. Пересдача не удаляет прежнюю справку —
 * история загрузок остаётся, но действует последняя.
 */
function latestByType(documents: readonly DocumentRecord[]): Map<string, DocumentRecord> {
  const latest = new Map<string, DocumentRecord>();

  for (const document of documents) {
    const known = latest.get(document.documentTypeId);
    if (known === undefined || known.createdAt <= document.createdAt) {
      latest.set(document.documentTypeId, document);
    }
  }

  return latest;
}

export async function listDocumentCards(
  actor: UserActor,
  residencyId: string,
  deps: DocumentDeps = {},
): Promise<DocumentCard[]> {
  const { executor, today } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  // Чтение идёт через видимость проживания: своё — жильцу, дом — админу.
  void residency;

  const [types, documents] = await Promise.all([
    listDocumentTypes(actor.context, {}, executor),
    listDocuments(actor.context, { residencyId }, executor),
  ]);

  const latest = latestByType(documents);

  return types.map((type) => {
    const document = latest.get(type.id) ?? null;
    const validUntil =
      document?.validUntil === null || document?.validUntil === undefined
        ? null
        : parseBusinessDate(document.validUntil);

    return {
      type,
      document,
      validity: document === null ? null : documentValidity(validUntil, today),
      daysLeft: document === null ? null : daysUntilExpiry(validUntil, today),
    };
  });
}

/**
 * Загрузка документа: файл уже принят двухшаговой загрузкой (T2.6),
 * здесь он связывается с типом и получает срок действия.
 */
export async function submitDocument(
  actor: UserActor,
  input: SubmitDocumentInput,
  deps: DocumentDeps = {},
): Promise<DocumentRecord> {
  const { executor, today } = resolve(deps);

  await assertDocumentAccess(actor, 'document.upload', input.residencyId, executor);

  const type = await requireDocumentType(actor.context, input.documentTypeId, executor);
  const file = await requireFile(actor.context, input.fileId, executor);

  if (file.status !== 'ready') {
    // Недокачанный файл документом не является: он ещё может не дойти.
    throw new ConflictError('Файл не подтверждён');
  }

  if (file.residencyId !== input.residencyId) {
    throw new NotFoundError('Файл не найден');
  }

  const rules = { validityMonths: type.validityMonths, requiresIssueDate: type.requiresIssueDate };
  const dates = { rules, uploadedOn: today, issueDate: input.issueDate };

  const rejection = checkDocumentDates(dates);
  if (rejection !== null) {
    throw new ValidationError(rejection);
  }

  const period = documentPeriod(dates);

  return executor.transaction(async (tx) => {
    const document = await createDocument(
      actor.context,
      {
        userId: actor.context.userId,
        residencyId: input.residencyId,
        documentTypeId: type.id,
        fileId: file.id,
        issueDate: input.issueDate,
        validFrom: period.validFrom,
        validUntil: period.validUntil,
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.documentSubmitted,
        entityType: 'document',
        entityId: document.id,
        after: {
          documentType: type.code,
          issueDate: document.issueDate,
          validUntil: document.validUntil,
        },
      },
      tx,
    );

    return document;
  });
}

/**
 * Проверка админом. Отклонение без причины не принимается: жилец должен
 * узнать, что именно исправить, — уведомление об отклонении так и устроено
 * (модуль 1, «Уведомления»).
 */
export async function reviewDocument(
  actor: UserActor,
  documentId: string,
  decision: ReviewDecision,
  deps: DocumentDeps = {},
): Promise<DocumentRecord> {
  const { executor } = resolve(deps);

  const document = await requireDocument(actor.context, documentId, executor);
  await assertDocumentAccess(actor, 'document.review', document.residencyId, executor);

  const reason = decision.reason?.trim() ?? '';
  if (!decision.approve && reason === '') {
    throw new ValidationError('documents.rejectReasonRequired');
  }

  return executor.transaction(async (tx) => {
    const updated = await updateDocument(
      actor.context,
      document.id,
      {
        status: decision.approve ? 'approved' : 'rejected',
        rejectReason: decision.approve ? null : reason,
        reviewedBy: actor.context.userId,
        reviewedAt: now(),
      },
      tx,
    );

    if (updated === null) {
      throw new NotFoundError('Документ не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: decision.approve ? AUDIT_ACTIONS.documentApproved : AUDIT_ACTIONS.documentRejected,
        entityType: 'document',
        entityId: updated.id,
        before: { status: document.status },
        after: { status: updated.status, rejectReason: updated.rejectReason },
      },
      tx,
    );

    return updated;
  });
}

/** Документы дома, ожидающие проверки: рабочий список админа. */
export async function listPendingDocuments(
  actor: UserActor,
  deps: DocumentDeps = {},
): Promise<DocumentRecord[]> {
  const { executor } = resolve(deps);

  return listDocuments(actor.context, { status: 'uploaded' }, executor);
}
