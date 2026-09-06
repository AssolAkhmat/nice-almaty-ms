import { and, eq, inArray } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { getDb, type Executor } from '../client';
import { files, residencies, type FileRecord, type NewFileRecord } from '../schema';
import { residencyVisibility } from './residencies';

import type { AccessContext } from '../access';

/**
 * Файлы. Видимость идёт через проживание тем же правилом, что и всё
 * остальное в фазе 2: жилец — свои, админ — своего дома, суперадмин — сети.
 *
 * Файл без проживания (уровня сети) в фазе 2 не создаётся: у таких файлов
 * не было бы владельца, а значит и правила видимости. Появятся — правило
 * придётся дописать здесь, а не обойти в вызывающем коде.
 */
function visibleResidencies(context: AccessContext, executor: Executor) {
  return executor
    .select({ id: residencies.id })
    .from(residencies)
    .where(residencyVisibility(context));
}

function scope(context: AccessContext, executor: Executor) {
  return and(
    eq(files.orgId, context.orgId),
    inArray(files.residencyId, visibleResidencies(context, executor)),
  );
}

/*
 * `id` разрешён на входе: путь в хранилище содержит идентификатор записи
 * (docs/01-ARCHITECTURE.md), поэтому он должен быть известен до вставки.
 * `status` не разрешён: новый файл всегда `pending`, готовым он становится
 * только через подтверждение.
 */
export type FileInput = Omit<NewFileRecord, 'orgId' | 'status'>;

export async function createFile(
  context: AccessContext,
  input: FileInput,
  executor: Executor = getDb(),
): Promise<FileRecord> {
  const [file] = await executor
    .insert(files)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (file === undefined) {
    throw new Error('Файл не создан');
  }

  return file;
}

export async function findFile(
  context: AccessContext,
  fileId: string,
  executor: Executor = getDb(),
): Promise<FileRecord | null> {
  const [file] = await executor
    .select()
    .from(files)
    .where(and(scope(context, executor), eq(files.id, fileId)))
    .limit(1);

  return file ?? null;
}

export async function requireFile(
  context: AccessContext,
  fileId: string,
  executor: Executor = getDb(),
): Promise<FileRecord> {
  const file = await findFile(context, fileId, executor);
  if (file === null) {
    throw new NotFoundError('Файл не найден');
  }

  return file;
}

export async function updateFile(
  context: AccessContext,
  fileId: string,
  patch: Partial<Omit<NewFileRecord, 'id' | 'orgId' | 'residencyId'>>,
  executor: Executor = getDb(),
): Promise<FileRecord | null> {
  const [file] = await executor
    .update(files)
    .set({ ...patch, updatedAt: now() })
    .where(and(scope(context, executor), eq(files.id, fileId)))
    .returning();

  return file ?? null;
}
