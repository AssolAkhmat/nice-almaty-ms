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
  /**
   * Переопределения полномочий админа: действие — разрешено ли.
   *
   * Собирается там же, где сессия, и живёт не дольше запроса: снятое право
   * обязано действовать сразу, а не после перелогина. Пусто — действуют
   * умолчания (`DEFAULT_OFF_FOR_ADMIN` и матрица).
   *
   * Суперадмина и жильца не касается: у первого урезание сети самому себе
   * не полномочие, а запертая изнутри дверь; у второго прав и так `self`.
   */
  readonly overrides?: Readonly<Partial<Record<string, boolean>>>;
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
      /*
       * У суперадмина дома нет (D11), и тогда видна вся сеть. Дом в контексте
       * суперадмина появляется единственным способом — токеном API, выданным
       * на один дом (`src/lib/api/token-auth.ts`). До 20 сентября 2026 такой
       * токен область не сужал: обещание «дом токена сужает область» было
       * словами в комментарии, а `visibleHouseIds` всё равно отдавал `all`.
       */
      return context.houseId === null ? 'all' : [context.houseId];
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
