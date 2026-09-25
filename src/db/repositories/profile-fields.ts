import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { now } from '@/lib/time';

import { type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  profileFieldDefs,
  profileFieldValues,
  type ProfileFieldDef,
  type ProfileFieldType,
  type ProfileFieldValue,
} from '../schema';

/**
 * Дополнительные поля профиля: объявления и значения.
 *
 * Здесь только хранение. Что считать допустимым значением, решает база
 * (триггер `profile_field_values_match_def`) и сервис; кому это видно —
 * `src/lib/authz.ts`.
 */
export interface FieldDefInput {
  code: string;
  nameI18n: Record<string, string>;
  type: ProfileFieldType;
  isRequired: boolean;
  options: string[];
  sortOrder: number;
}

export async function listFieldDefs(
  context: AccessContext,
  options: { includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<ProfileFieldDef[]> {
  const conditions = [eq(profileFieldDefs.orgId, context.orgId)];

  if (options.includeArchived !== true) {
    conditions.push(isNull(profileFieldDefs.archivedAt));
  }

  return executor
    .select()
    .from(profileFieldDefs)
    .where(and(...conditions))
    .orderBy(asc(profileFieldDefs.sortOrder), asc(profileFieldDefs.id));
}

export async function findFieldDef(
  context: AccessContext,
  id: string,
  executor: Executor = getDb(),
): Promise<ProfileFieldDef | null> {
  const [found] = await executor
    .select()
    .from(profileFieldDefs)
    .where(and(eq(profileFieldDefs.id, id), eq(profileFieldDefs.orgId, context.orgId)))
    .limit(1);

  return found ?? null;
}

export async function createFieldDef(
  context: AccessContext,
  input: FieldDefInput,
  executor: Executor = getDb(),
): Promise<ProfileFieldDef> {
  const [created] = await executor
    .insert(profileFieldDefs)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (created === undefined) {
    throw new Error('Поле профиля не сохранено');
  }

  return created;
}

export async function updateFieldDef(
  context: AccessContext,
  id: string,
  patch: Partial<Omit<FieldDefInput, 'code' | 'type'>> & { archivedAt?: Date | null },
  executor: Executor = getDb(),
): Promise<ProfileFieldDef> {
  const [updated] = await executor
    .update(profileFieldDefs)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(profileFieldDefs.id, id), eq(profileFieldDefs.orgId, context.orgId)))
    .returning();

  if (updated === undefined) {
    throw new Error('Поле профиля не обновлено');
  }

  return updated;
}

/**
 * Значения одного человека: и по действующим полям, и по архивированным.
 * Архивированное поле обязано остаться читаемым — на него ссылаются
 * уже подписанные договоры.
 */
export async function listFieldValues(
  context: AccessContext,
  userId: string,
  executor: Executor = getDb(),
): Promise<ProfileFieldValue[]> {
  return executor
    .select()
    .from(profileFieldValues)
    .where(and(eq(profileFieldValues.orgId, context.orgId), eq(profileFieldValues.userId, userId)))
    .orderBy(asc(profileFieldValues.fieldId), asc(profileFieldValues.id));
}

/** Значения нескольких людей сразу: список жильцов не делает запрос на строку. */
export async function listFieldValuesOf(
  context: AccessContext,
  userIds: readonly string[],
  executor: Executor = getDb(),
): Promise<ProfileFieldValue[]> {
  if (userIds.length === 0) {
    return [];
  }

  return executor
    .select()
    .from(profileFieldValues)
    .where(
      and(
        eq(profileFieldValues.orgId, context.orgId),
        inArray(profileFieldValues.userId, [...userIds]),
      ),
    )
    .orderBy(
      asc(profileFieldValues.userId),
      asc(profileFieldValues.fieldId),
      asc(profileFieldValues.id),
    );
}

export async function setFieldValue(
  context: AccessContext,
  input: { userId: string; fieldId: string; value: string },
  executor: Executor = getDb(),
): Promise<ProfileFieldValue> {
  const [existing] = await executor
    .select()
    .from(profileFieldValues)
    .where(
      and(
        eq(profileFieldValues.orgId, context.orgId),
        eq(profileFieldValues.userId, input.userId),
        eq(profileFieldValues.fieldId, input.fieldId),
      ),
    )
    .limit(1);

  if (existing !== undefined) {
    const [updated] = await executor
      .update(profileFieldValues)
      .set({ value: input.value, updatedAt: now() })
      .where(eq(profileFieldValues.id, existing.id))
      .returning();

    if (updated === undefined) {
      throw new Error('Значение поля не обновлено');
    }

    return updated;
  }

  const [created] = await executor
    .insert(profileFieldValues)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (created === undefined) {
    throw new Error('Значение поля не сохранено');
  }

  return created;
}

/**
 * Пустое значение не хранится строкой: его отвергает и триггер. Стереть
 * значение — удалить строку, и это отдельное действие, а не запись пустоты.
 */
export async function clearFieldValue(
  context: AccessContext,
  input: { userId: string; fieldId: string },
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .delete(profileFieldValues)
    .where(
      and(
        eq(profileFieldValues.orgId, context.orgId),
        eq(profileFieldValues.userId, input.userId),
        eq(profileFieldValues.fieldId, input.fieldId),
      ),
    );
}
