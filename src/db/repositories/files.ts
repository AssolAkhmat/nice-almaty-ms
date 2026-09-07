import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { getDb, type Executor } from '../client';
import { files, residencies, type FileRecord, type NewFileRecord } from '../schema';
import { residencyVisibility } from './residencies';

import { visibleHouseIds, type AccessContext } from '../access';

/**
 * Файлы. Видимость идёт через владельца: у документа жильца это проживание
 * (жилец — свои, админ — своего дома, суперадмин — сети), у чека к ущербу,
 * расходу или коммуналке — дом.
 *
 * Ровно одно из двух полей заполнено. Файл без обоих не виден никому:
 * у него нет владельца, а значит и правила видимости, — и это лучше,
 * чем правило, выведенное на месте вызова (T3.12).
 */
function visibleResidencies(context: AccessContext, executor: Executor) {
  return executor
    .select({ id: residencies.id })
    .from(residencies)
    .where(residencyVisibility(context));
}

/**
 * Файл дома виден админу этого дома; файл без дома и без проживания —
 * уровня сети (чек к расходу с общего счёта) и виден тому, кто видит сеть
 * целиком, то есть суперадмину.
 */
function visibleHouses(context: AccessContext) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return or(isNotNull(files.houseId), isNull(files.residencyId));
  }

  return visible.length === 0 ? sql`false` : inArray(files.houseId, [...visible]);
}

function scope(context: AccessContext, executor: Executor) {
  return and(
    eq(files.orgId, context.orgId),
    or(inArray(files.residencyId, visibleResidencies(context, executor)), visibleHouses(context)),
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
