import { canSeeHouse, type AccessContext, type AccessRole } from '@/db/access';

import { ForbiddenError, NotFoundError } from './errors';
import {
  DEFAULT_OFF_FOR_ADMIN,
  PERMISSIONS,
  type Action,
  type PermissionScope,
} from './permissions';

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

/**
 * Включено ли полномочие у этого админа (указание владельца, 23 сентября 2026).
 *
 * Матрица говорит, что действие вообще положено роли; здесь решается,
 * включено ли оно в этой сети и у этого человека. Часть полномочий выключена
 * по умолчанию (`DEFAULT_OFF_FOR_ADMIN`), остальные по умолчанию есть —
 * разница только в том, что считать умолчанием при отсутствии записи.
 *
 * Суперадмина не касается никогда и ни при каких данных: проверка стоит
 * на роли, а не на наличии записи, и негативная фикстура держит это правило.
 */
export function enabledForContext(context: AccessContext, action: Action): boolean {
  if (context.role !== 'admin') {
    return true;
  }

  return context.overrides?.[action] ?? !DEFAULT_OFF_FOR_ADMIN.includes(action);
}

export function can(
  context: AccessContext,
  action: Action,
  target: PermissionTarget = {},
): boolean {
  if (!enabledForContext(context, action)) {
    return false;
  }

  switch (scopeOf(context.role, action)) {
    case 'none':
      return false;
    case 'org':
      /*
       * Сеть целиком — но не шире, чем область самого контекста. Дом в контексте
       * бывает только у токена API, выданного на один дом: без этой строки такой
       * токен суперадмина действовал бы на любой дом, хотя выдан на один.
       * У обычного суперадмина дом `null`, и `canSeeHouse` отвечает `true`.
       */
      return target.houseId == null || canSeeHouse(context, target.houseId);
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
  if (scopeOf(context.role, action) === 'none' || !enabledForContext(context, action)) {
    throw new ForbiddenError(`Действие ${action} недоступно роли ${context.role}`);
  }

  if (!can(context, action, target)) {
    throw new NotFoundError('Не найдено');
  }
}
