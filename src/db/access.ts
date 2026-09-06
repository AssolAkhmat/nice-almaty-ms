import { NotFoundError } from '@/lib/errors';

/**
 * Контекст доступа передаётся в каждый запрос к данным.
 * Фильтрация по org_id и house_id живёт в репозиториях, а не в интерфейсе
 * (CLAUDE.md §3), поэтому контекст — обязательный первый аргумент.
 */
export type AccessRole = 'superadmin' | 'admin' | 'resident';

export interface AccessContext {
  readonly orgId: string;
  readonly userId: string;
  readonly role: AccessRole;
  /** Дом админа. У суперадмина и жильца — null (следствие D11). */
  readonly houseId: string | null;
}

/**
 * Область видимости по домам.
 * `all` — суперадмин; массив — конкретные дома; пустой массив — ничего.
 *
 * Жилец в фазе 1 не привязан к дому: связь идёт через проживание,
 * которое появляется в фазе 2. До тех пор список домов для него пуст.
 */
export function visibleHouseIds(context: AccessContext): 'all' | readonly string[] {
  switch (context.role) {
    case 'superadmin':
      return 'all';
    case 'admin':
      return context.houseId === null ? [] : [context.houseId];
    case 'resident':
      return [];
  }
}

export function canSeeHouse(context: AccessContext, houseId: string): boolean {
  const visible = visibleHouseIds(context);

  return visible === 'all' || visible.includes(houseId);
}

/**
 * Дом вне области видимости неотличим от несуществующего (P1-1):
 * иначе админ перебором id узнаёт, сколько домов в сети и какие.
 */
export function assertHouseVisible(context: AccessContext, houseId: string): void {
  if (!canSeeHouse(context, houseId)) {
    throw new NotFoundError('Дом не найден');
  }
}

export function isSuperadmin(context: AccessContext): boolean {
  return context.role === 'superadmin';
}
