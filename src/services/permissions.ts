import { getDb, type Executor } from '@/db/client';
import {
  listPermissionOverrides,
  setPermissionOverride,
} from '@/db/repositories/permission-overrides';
import { assertCan } from '@/lib/authz';
import {
  ADMIN_CAPABILITIES,
  CAPABILITY_KEYS,
  DEFAULT_OFF_FOR_ADMIN,
  type AdminCapability,
  type Action,
} from '@/lib/permissions';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { UserActor } from './users';

/**
 * Полномочия админа, которыми распоряжается сеть (указание владельца,
 * 23 сентября 2026).
 *
 * Переключателя три, а действий за ними четыре: документы читают и проверяют
 * одним движением — не видя справку, принять её нельзя.
 *
 * Все три по умолчанию выключены. Это единственное, чем они отличаются
 * от прочих полномочий админа: механизм один и тот же, разнится лишь то,
 * что считать умолчанием при отсутствии записи (`DEFAULT_OFF_FOR_ADMIN`).
 *
 * Суперадмина переключатели не касаются никогда — проверка в `authz.ts`
 * стоит на роли, а не на наличии записи в базе.
 */
export interface PermissionDeps {
  executor?: Executor;
}

function defaultOf(actions: readonly Action[]): boolean {
  return actions.every((action) => !DEFAULT_OFF_FOR_ADMIN.includes(action));
}

export async function readAdminCapabilities(
  actor: UserActor,
  deps: PermissionDeps = {},
): Promise<Record<AdminCapability, boolean>> {
  const executor = deps.executor ?? getDb();

  assertCan(actor.context, 'settings.org.read');

  const rows = await listPermissionOverrides(actor.context, { userId: null }, executor);
  const byAction = new Map(rows.map((row) => [row.action, row.allowed]));

  const result = {} as Record<AdminCapability, boolean>;

  for (const key of CAPABILITY_KEYS) {
    const actions = ADMIN_CAPABILITIES[key];

    /*
     * Переключатель включён, когда включены все действия группы. Частично
     * включённая группа читается как выключенная: обещать админу половину
     * возможности хуже, чем не обещать ничего.
     */
    result[key] = actions.every((action) => byAction.get(action) ?? defaultOf([action]));
  }

  return result;
}

export async function setAdminCapability(
  actor: UserActor,
  capability: AdminCapability,
  enabled: boolean,
  deps: PermissionDeps = {},
): Promise<void> {
  const executor = deps.executor ?? getDb();

  assertCan(actor.context, 'settings.org.write');

  const actions = ADMIN_CAPABILITIES[capability];

  await executor.transaction(async (tx) => {
    for (const action of actions) {
      await setPermissionOverride(
        actor.context,
        { userId: null, action, allowed: enabled, updatedBy: actor.context.userId },
        tx,
      );
    }

    /*
     * Запись построчно и с именем действия: «кому, что, когда». Ради этого
     * полномочия и живут отдельной таблицей, а не массивом в одной строке.
     */
    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.permissionChanged,
        entityType: 'permission',
        entityId: capability,
        before: { enabled: !enabled },
        after: { enabled, scope: 'org', actions: [...actions] },
      },
      tx,
    );
  });
}
