import { canSeeHouse, type AccessContext, type AccessRole } from '@/db/access';

import { ForbiddenError, NotFoundError } from './errors';
import { PERMISSIONS, type Action, type PermissionScope } from './permissions';

/**
 * Единственная точка проверки прав (CLAUDE.md §3).
 * Собственной логики распределения прав здесь нет — только чтение матрицы
 * из `permissions.ts` и правило различия 403 и 404 (P1-1).
 */
export interface PermissionTarget {
  /** Дом, к которому относится объект. */
  houseId?: string | null;
  /** Пользователь, к которому относится объект. */
  userId?: string;
}

export function scopeOf(role: AccessRole, action: Action): PermissionScope {
  return PERMISSIONS[role][action];
}

export function can(
  context: AccessContext,
  action: Action,
  target: PermissionTarget = {},
): boolean {
  switch (scopeOf(context.role, action)) {
    case 'none':
      return false;
    case 'org':
      return true;
    case 'house':
      return target.houseId != null && canSeeHouse(context, target.houseId);
    case 'self':
      return target.userId !== undefined && target.userId === context.userId;
  }
}

/**
 * Различие кодов ответа (P1-1):
 * действие не положено роли вовсе — 403;
 * действие положено, но объект вне области видимости — 404,
 * иначе перебором идентификаторов узнаётся состав сети.
 */
export function assertCan(
  context: AccessContext,
  action: Action,
  target: PermissionTarget = {},
): void {
  if (scopeOf(context.role, action) === 'none') {
    throw new ForbiddenError(`Действие ${action} недоступно роли ${context.role}`);
  }

  if (!can(context, action, target)) {
    throw new NotFoundError('Не найдено');
  }
}
