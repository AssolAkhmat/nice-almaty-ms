import { assertCan } from '@/lib/authz';

import { assertScope } from './token-auth';

import type { PermissionTarget } from '@/lib/authz';
import type { Action } from '@/lib/permissions';
import type { UserActor } from '@/services/users';

/**
 * Проверка доступа в REST (docs/06-API.md).
 *
 * Две проверки, а не одна. Роль отвечает на вопрос «вправе ли этот
 * человек», скоуп — «разрешено ли это боту, которому он выдал ключ».
 * У входа по сессии скоупов нет вовсе: человек ограничен ролью,
 * и требовать от него скоуп было бы бессмыслицей.
 */
export function assertApiAccess(
  actor: UserActor,
  action: Action,
  target: PermissionTarget = {},
): void {
  assertCan(actor.context, action, target);

  if (actor.scopes !== undefined) {
    assertScope(actor.scopes, action);
  }
}
