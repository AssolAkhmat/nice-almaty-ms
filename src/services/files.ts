import { getStorageProvider } from '@/adapters/storage';
import { getDb, type Executor } from '@/db/client';
import { createFile, requireFile, updateFile } from '@/db/repositories/files';
import { requireHouse, requireHouseOfResidency } from '@/db/repositories/houses';
import { requireResidency } from '@/db/repositories/residencies';
import {
  asAllowedMime,
  checkUpload,
  documentStorageKey,
  houseFileStorageKey,
  NETWORK_STORAGE_SEGMENT,
  sniffMime,
  MAX_UPLOAD_BYTES,
} from '@/domain/files';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { StorageProvider } from '@/adapters/storage';
import type { FileRecord } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Двухшаговая загрузка файлов (docs/01-ARCHITECTURE.md, D4).
 *
 * Шаг 1 — сессия: права, тип и размер проверены, запись создана в `pending`.
 * Шаг 2 — байты идут прямо в хранилище; у локального драйвера прямого адреса
 * нет, поэтому их принимает приложение.
 * Шаг 3 — подтверждение: сервер сверяет, что легло в хранилище, и только
 * тогда файл становится `ready`.
 *
 * Файл вне статуса `ready` наружу не отдаётся никогда: недокачанный
 * или подменённый файл не должен выглядеть как принятый документ.
 */
export interface FileDeps {
  executor?: Executor;
  storage?: StorageProvider;
}

interface Resolved {
  executor: Executor;
  storage: StorageProvider;
}

function resolve(deps: FileDeps): Resolved {
  return { executor: deps.executor ?? getDb(), storage: deps.storage ?? getStorageProvider() };
}

export interface UploadSessionInput {
  residencyId: string;
  documentType: string;
  mime: string;
  sizeBytes: number;
  originalName: string;
}

export interface UploadSessionResult {
  fileId: string;
  upload: {
    url: string;
    method: 'PUT' | 'POST';
    headers: Record<string, string>;
  };
  maxBytes: number;
}

export interface FileContent {
  stream: ReadableStream<Uint8Array>;
  mime: string;
  sizeBytes: number;
  originalName: string;
}

/** Права на файл берутся у проживания, к которому он прикреплён. */
/**
 * Права на файл — права на его владельца: у документа жильца это проживание,
 * у чека — дом (T3.12). Файл без владельца не отдаётся никому: правило
 * видимости для него вывести неоткуда.
 */
async function assertFileAccess(
  actor: UserActor,
  action: 'file.upload' | 'file.read',
  owner: { residencyId: string | null; houseId: string | null },
  executor: Executor,
): Promise<void> {
  if (owner.residencyId !== null) {
    const residency = await requireResidency(actor.context, owner.residencyId, executor);

    assertCan(actor.context, action, {
      houseId: residency.houseId,
      userId: residency.userId,
    });

    return;
  }

  /*
   * Ни проживания, ни дома — файл уровня сети (чек к расходу с общего
   * счёта). Цели у проверки нет: право уровня сети есть только у роли,
   * которой сеть видна целиком.
   */
  if (owner.houseId === null) {
    assertCan(actor.context, action);

    return;
  }

  assertCan(actor.context, action, { houseId: owner.houseId });
}

function rejectUpload(input: { mime: string; sizeBytes: number }): void {
  const rejection = checkUpload(input);

  if (rejection !== null) {
    throw new ValidationError(rejection, { maxBytes: MAX_UPLOAD_BYTES });
  }
}

export async function createUploadSession(
  actor: UserActor,
  input: UploadSessionInput,
  deps: FileDeps = {},
): Promise<UploadSessionResult> {
  const { executor, storage } = resolve(deps);

  const residency = await requireResidency(actor.context, input.residencyId, executor);
  assertCan(actor.context, 'file.upload', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  // Тип и размер проверяются до записи: отказ не должен оставлять следов.
  rejectUpload(input);

  // Дом берётся через проживание: у жильца в контексте дома нет (D11).
  const house = await requireHouseOfResidency(actor.context, residency.id, executor);
  const fileId = crypto.randomUUID();
  const path = documentStorageKey({
    houseSlug: house.slug,
    residencyId: residency.id,
    documentType: input.documentType,
    fileId,
    mime: input.mime,
  });

  const file = await createFile(
    actor.context,
    {
      id: fileId,
      residencyId: residency.id,
      provider: storage.driver,
      path,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      originalName: input.originalName,
      uploadedBy: actor.context.userId,
      scope: { documentType: input.documentType },
    },
    executor,
  );

  const target = await storage
    .createUploadTarget(path, { mime: input.mime, sizeBytes: input.sizeBytes })
    .catch(async (error: unknown) => {
      // Сессия без цели загрузки бесполезна: пусть она будет явно негодной,
      // а не вечно ожидающей байтов, которые некуда прислать.
      await updateFile(actor.context, file.id, { status: 'failed' }, executor);
      throw error;
    });

  if (target.kind === 'external') {
    await updateFile(actor.context, file.id, { externalId: target.externalId }, executor);

    return {
      fileId: file.id,
      upload: { url: target.url, method: target.method, headers: target.headers },
      maxBytes: MAX_UPLOAD_BYTES,
    };
  }

  return {
    fileId: file.id,
    upload: { url: `/api/v1/files/${file.id}/blob`, method: 'PUT', headers: {} },
    maxBytes: MAX_UPLOAD_BYTES,
  };
}

export interface HouseUploadInput {
  /** Дом, которому принадлежит чек; `null` — расход уровня сети. */
  houseId: string | null;
  /** Назначение: `damage-receipt`, `expense-receipt`, `utility-receipt`. */
  purpose: string;
  mime: string;
  sizeBytes: number;
  originalName: string;
}

/** Назначения файлов дома. Перечень закрыт: путь хранения из него собирается. */
export const HOUSE_FILE_PURPOSES = [
  'damage-receipt',
  'expense-receipt',
  'utility-receipt',
] as const;

export type HouseFilePurpose = (typeof HOUSE_FILE_PURPOSES)[number];

/**
 * Сессия загрузки чека — файла, принадлежащего дому, а не проживанию
 * (T3.12). Чек к ущербу, расходу и строке коммуналки жильцу не принадлежит,
 * и привязывать его к чьему-то проживанию значило бы отдать его этому
 * жильцу вместе с правом чтения.
 */
export async function createHouseUploadSession(
  actor: UserActor,
  input: HouseUploadInput,
  deps: FileDeps = {},
): Promise<UploadSessionResult> {
  const { executor, storage } = resolve(deps);

  if (!(HOUSE_FILE_PURPOSES as readonly string[]).includes(input.purpose)) {
    throw new ValidationError('files.unknownPurpose');
  }

  const house =
    input.houseId === null ? null : await requireHouse(actor.context, input.houseId, executor);

  if (house === null) {
    assertCan(actor.context, 'file.upload');
  } else {
    assertCan(actor.context, 'file.upload', { houseId: house.id });
  }

  // Тип и размер проверяются до записи: отказ не должен оставлять следов.
  rejectUpload(input);

  const fileId = crypto.randomUUID();
  const path = houseFileStorageKey({
    houseSlug: house?.slug ?? NETWORK_STORAGE_SEGMENT,
    purpose: input.purpose,
    fileId,
    mime: input.mime,
  });

  const file = await createFile(
    actor.context,
    {
      id: fileId,
      houseId: house?.id ?? null,
      provider: storage.driver,
      path,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      originalName: input.originalName,
      uploadedBy: actor.context.userId,
      scope: { purpose: input.purpose },
    },
    executor,
  );

  const target = await storage
    .createUploadTarget(path, { mime: input.mime, sizeBytes: input.sizeBytes })
    .catch(async (error: unknown) => {
      await updateFile(actor.context, file.id, { status: 'failed' }, executor);
      throw error;
    });

  if (target.kind === 'external') {
    await updateFile(actor.context, file.id, { externalId: target.externalId }, executor);

    return {
      fileId: file.id,
      upload: { url: target.url, method: target.method, headers: target.headers },
      maxBytes: MAX_UPLOAD_BYTES,
    };
  }

  return {
    fileId: file.id,
    upload: { url: `/api/v1/files/${file.id}/blob`, method: 'PUT', headers: {} },
    maxBytes: MAX_UPLOAD_BYTES,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // WebCrypto, а не node:crypto: тот же код работает и в edge-рантайме.
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Приём байтов приложением — второй шаг для драйверов без прямого адреса.
 * Здесь и только здесь содержимое проходит через приложение, поэтому здесь
 * же сверяется настоящий тип: заявленный тип — это слово клиента.
 */
export async function receiveUploadedBytes(
  actor: UserActor,
  fileId: string,
  bytes: Uint8Array,
  deps: FileDeps = {},
): Promise<FileRecord> {
  const { executor, storage } = resolve(deps);

  const file = await requireFile(actor.context, fileId, executor);
  await assertFileAccess(actor, 'file.upload', file, executor);

  if (file.status !== 'pending') {
    throw new ConflictError('Файл уже принят: повторная загрузка невозможна');
  }

  const fail = async (message: string): Promise<never> => {
    await updateFile(actor.context, file.id, { status: 'failed' }, executor);
    throw new ValidationError(message, { maxBytes: MAX_UPLOAD_BYTES });
  };

  const rejection = checkUpload({ mime: file.mime, sizeBytes: bytes.byteLength });
  if (rejection !== null) {
    await fail(rejection);
  }

  if (bytes.byteLength !== file.sizeBytes) {
    await fail('files.sizeMismatch');
  }

  // Заявленный тип — слово клиента; настоящий тип виден в первых байтах.
  if (sniffMime(bytes) !== asAllowedMime(file.mime)) {
    await fail('files.mimeMismatch');
  }

  const stored = await storage.put(file.path, bytes);
  const updated = await updateFile(
    actor.context,
    file.id,
    { sizeBytes: stored.sizeBytes, checksum: `sha256:${await sha256(bytes)}` },
    executor,
  );

  if (updated === null) {
    throw new NotFoundError('Файл не найден');
  }

  return updated;
}

/**
 * Подтверждение: сервер смотрит, что действительно легло в хранилище.
 * Заявленный размер сверяется с фактическим — иначе клиент, обещавший
 * мегабайт, мог бы положить сотню.
 */
export async function completeUpload(
  actor: UserActor,
  fileId: string,
  deps: FileDeps = {},
): Promise<FileRecord> {
  const { executor, storage } = resolve(deps);

  const file = await requireFile(actor.context, fileId, executor);
  await assertFileAccess(actor, 'file.upload', file, executor);

  if (file.status === 'ready') {
    return file;
  }

  if (file.status === 'failed') {
    throw new ConflictError('Загрузка уже отмечена неудачной');
  }

  const stored = await storage.head(file.path);

  if (stored === null) {
    await updateFile(actor.context, file.id, { status: 'failed' }, executor);
    throw new ConflictError('Байты в хранилище не дошли');
  }

  const rejection = checkUpload({ mime: file.mime, sizeBytes: stored.sizeBytes });
  if (rejection !== null || stored.sizeBytes !== file.sizeBytes) {
    await updateFile(actor.context, file.id, { status: 'failed' }, executor);
    throw new ValidationError(rejection ?? 'files.sizeMismatch', { maxBytes: MAX_UPLOAD_BYTES });
  }

  return executor.transaction(async (tx) => {
    const ready = await updateFile(
      actor.context,
      file.id,
      { status: 'ready', sizeBytes: stored.sizeBytes },
      tx,
    );

    if (ready === null) {
      throw new NotFoundError('Файл не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.fileUploaded,
        entityType: 'file',
        entityId: ready.id,
        after: {
          residencyId: ready.residencyId,
          mime: ready.mime,
          sizeBytes: ready.sizeBytes,
          originalName: ready.originalName,
        },
      },
      tx,
    );

    return ready;
  });
}

/**
 * Отдача содержимого. Публичных ссылок не бывает: каждый доступ проходит
 * ту же проверку прав, что и всё остальное (docs/01-ARCHITECTURE.md).
 */
export async function readFileContent(
  actor: UserActor,
  fileId: string,
  deps: FileDeps = {},
): Promise<FileContent> {
  const { executor, storage } = resolve(deps);

  const file = await requireFile(actor.context, fileId, executor);
  await assertFileAccess(actor, 'file.read', file, executor);

  // Незавершённая загрузка содержимым не является.
  if (file.status !== 'ready') {
    throw new NotFoundError('Файл не найден');
  }

  const stream = await storage.stream(file.path);
  if (stream === null) {
    throw new NotFoundError('Файл не найден');
  }

  /*
   * Документы жильца — медицинские справки и удостоверение. Кто их открывал,
   * кроме самого владельца, видно в журнале: в ТЗ такого требования нет,
   * но из двух прочтений выбрано более осторожное (docs/08-DECISIONS.md).
   */
  if (file.uploadedBy !== actor.context.userId) {
    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.fileRead,
        entityType: 'file',
        entityId: file.id,
        after: { residencyId: file.residencyId, scope: file.scope },
      },
      executor,
    );
  }

  return {
    stream,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    originalName: file.originalName,
  };
}
