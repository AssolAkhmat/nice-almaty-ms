import type { Action } from '@/lib/permissions';

/**
 * Скоупы токена API (docs/06-API.md, «Аутентификация»).
 *
 * Скоуп — не право, а сужение: он говорит, какую часть того, что уже
 * может выдавший, разрешено делать боту. Поэтому каждый скоуп привязан
 * к действию матрицы прав, и выдать токен на то, чего у человека нет,
 * нельзя — иначе токен стал бы способом обойти роль.
 */
export const API_SCOPES = [
  'residents:read',
  'residents:write',
  'rotations:read',
  'rotations:write',
  'invoices:read',
  'invoices:write',
  'absences:read',
  'absences:write',
  'houses:read',
  'beds:read',
  'notifications:write',
  'reports:read',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/**
 * Действие, которым проверяется скоуп.
 *
 * `notifications:write` привязан к чтению жильцов: уведомление адресуется
 * человеку, и кто не вправе видеть жильцов, не вправе им и писать.
 * Собственного действия у уведомлений в матрице нет — оно и не нужно:
 * право писать всегда следовало из права видеть адресата.
 */
export const SCOPE_ACTIONS: Readonly<Record<ApiScope, Action>> = {
  'residents:read': 'user.read',
  'residents:write': 'user.updateProfile',
  'rotations:read': 'rotation.read',
  'rotations:write': 'rotation.manage',
  'invoices:read': 'invoice.read',
  'invoices:write': 'invoice.issue',
  'absences:read': 'absence.read',
  'absences:write': 'absence.review',
  'houses:read': 'house.read',
  'beds:read': 'bed.read',
  'notifications:write': 'user.read',
  'reports:read': 'accounting.read',
};

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Скоупы, которых нет в списке: их нельзя ни выдать, ни проверить. */
export function unknownScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !isApiScope(scope));
}

/**
 * Достаточно ли скоупов токена для действия.
 *
 * Токен без нужного скоупа получает отказ, даже если роль выдавшего
 * позволяла бы: скоуп сужает, а не расширяет.
 */
export function scopeAllows(scopes: readonly string[], action: Action): boolean {
  return scopes.some((scope) => isApiScope(scope) && SCOPE_ACTIONS[scope] === action);
}
