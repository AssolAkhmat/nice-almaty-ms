import { and, eq } from 'drizzle-orm';

import { now } from '@/lib/time';

import { assertHouseVisible, isSuperadmin, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { settings, type Setting } from '../schema';
import { ForbiddenError } from '@/lib/errors';

export type SettingsScope = 'org' | 'house';

/** Настройка дома видна только тем, кому виден дом; настройка сети — суперадмину. */
function assertScopeAccess(context: AccessContext, scope: SettingsScope, scopeId: string): void {
  if (scope === 'house') {
    assertHouseVisible(context, scopeId);
    return;
  }

  if (scopeId !== context.orgId || !isSuperadmin(context)) {
    throw new ForbiddenError('Настройки сети доступны только суперадмину');
  }
}

export async function listSettings(
  context: AccessContext,
  scope: SettingsScope,
  scopeId: string,
  executor: Executor = getDb(),
): Promise<Setting[]> {
  assertScopeAccess(context, scope, scopeId);

  return executor
    .select()
    .from(settings)
    .where(and(eq(settings.scope, scope), eq(settings.scopeId, scopeId)));
}

export async function getSetting(
  context: AccessContext,
  scope: SettingsScope,
  scopeId: string,
  key: string,
  executor: Executor = getDb(),
): Promise<Setting | null> {
  assertScopeAccess(context, scope, scopeId);

  const [setting] = await executor
    .select()
    .from(settings)
    .where(and(eq(settings.scope, scope), eq(settings.scopeId, scopeId), eq(settings.key, key)))
    .limit(1);

  return setting ?? null;
}

export async function putSetting(
  context: AccessContext,
  scope: SettingsScope,
  scopeId: string,
  key: string,
  value: unknown,
  executor: Executor = getDb(),
): Promise<Setting> {
  assertScopeAccess(context, scope, scopeId);

  const [setting] = await executor
    .insert(settings)
    .values({ scope, scopeId, key, value })
    .onConflictDoUpdate({
      target: [settings.scope, settings.scopeId, settings.key],
      set: { value, updatedAt: now() },
    })
    .returning();

  if (setting === undefined) {
    throw new Error('Настройка не сохранена');
  }

  return setting;
}
