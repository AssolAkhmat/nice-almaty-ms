import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';

import { now } from '@/lib/time';

import { type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { permissionOverrides, type PermissionOverride } from '../schema';

/**
 * Переопределения полномочий админа (указание владельца, 23 сентября 2026).
 *
 * Сетевое правило — строка без пользователя, личное — с пользователем;
 * личное сильнее. Здесь только хранение: что считать умолчанием, когда
 * строки нет, решает `src/lib/permissions.ts`, а применяет `authz.ts`.
 */
export async function loadOverridesFor(
  orgId: string,
  userId: string,
  executor: Executor = getDb(),
): Promise<Record<string, boolean>> {
  const rows = await executor
    .select()
    .from(permissionOverrides)
    .where(
      and(
        eq(permissionOverrides.orgId, orgId),
        or(isNull(permissionOverrides.userId), eq(permissionOverrides.userId, userId)),
      ),
    )
    /*
     * Сетевые строки идут первыми, личные — следом и перезаписывают их:
     * `nulls first` здесь не украшение, а способ отдать личному правилу
     * последнее слово без второго запроса.
     */
    .orderBy(sql`${permissionOverrides.userId} asc nulls first`, asc(permissionOverrides.id));

  const resolved: Record<string, boolean> = {};

  for (const row of rows) {
    resolved[row.action] = row.allowed;
  }

  return resolved;
}

export async function listPermissionOverrides(
  context: AccessContext,
  filter: { userId?: string | null } = {},
  executor: Executor = getDb(),
): Promise<PermissionOverride[]> {
  const conditions = [eq(permissionOverrides.orgId, context.orgId)];

  if (filter.userId === null) {
    conditions.push(isNull(permissionOverrides.userId));
  } else if (filter.userId !== undefined) {
    conditions.push(eq(permissionOverrides.userId, filter.userId));
  }

  return executor
    .select()
    .from(permissionOverrides)
    .where(and(...conditions))
    .orderBy(asc(permissionOverrides.action), asc(permissionOverrides.id));
}

export interface OverrideInput {
  /** Пусто — правило всей сети. */
  userId: string | null;
  action: string;
  allowed: boolean;
  updatedBy: string;
}

export async function setPermissionOverride(
  context: AccessContext,
  input: OverrideInput,
  executor: Executor = getDb(),
): Promise<PermissionOverride> {
  const existing = await executor
    .select()
    .from(permissionOverrides)
    .where(
      and(
        eq(permissionOverrides.orgId, context.orgId),
        eq(permissionOverrides.action, input.action),
        input.userId === null
          ? isNull(permissionOverrides.userId)
          : eq(permissionOverrides.userId, input.userId),
      ),
    )
    .limit(1);

  const [current] = existing;

  if (current !== undefined) {
    const [updated] = await executor
      .update(permissionOverrides)
      .set({ allowed: input.allowed, updatedBy: input.updatedBy, updatedAt: now() })
      .where(eq(permissionOverrides.id, current.id))
      .returning();

    if (updated === undefined) {
      throw new Error('Полномочие не обновлено');
    }

    return updated;
  }

  const [created] = await executor
    .insert(permissionOverrides)
    .values({
      orgId: context.orgId,
      userId: input.userId,
      action: input.action,
      allowed: input.allowed,
      updatedBy: input.updatedBy,
    })
    .returning();

  if (created === undefined) {
    throw new Error('Полномочие не сохранено');
  }

  return created;
}
