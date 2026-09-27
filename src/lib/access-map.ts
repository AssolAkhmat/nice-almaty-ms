import type { AccessRole } from '@/db/access';

import type { Action } from './permissions';

/**
 * Карта доступа к экранам (находка боевой эксплуатации P0-2,
 * 27 сентября 2026).
 *
 * Админ дома видел в меню раздел бухгалтерии. Сам роут отказывал, но пункт
 * меню показывался всем: список разделов не зависел ни от роли, ни от прав —
 * в `navigation.ts` даже стоял комментарий «с появлением ролей в фазе 1 он
 * станет зависеть от роли», и этого не случилось.
 *
 * Здесь один источник правды на три вещи: чем фильтруется меню, что написано
 * в `docs/09-ACCESS-MATRIX.md` и что проверяет табличный тест. Роли взяты
 * из `docs/00-PRD.md` («Пользователи и роли») и уточнений модулей; `action` —
 * право, которым раздел открывается, ровно то, что спрашивает сам экран.
 *
 * Правило: новый экран без записи здесь роняет тест. Забытая запись — это
 * забытая проверка доступа, а её не видно, пока кто-нибудь не откроет чужой
 * раздел.
 */
export interface RouteAccess {
  /** Путь в приложении, как он выглядит в адресной строке (без группы). */
  route: string;
  /**
   * Право, которым открывается раздел. `null` — раздел открыт всякому, кто
   * вошёл: дэшборд, свой профиль, свои уведомления.
   */
  action: Action | null;
  /** Кому раздел положен по ТЗ. Проверяется против матрицы прав тестом. */
  roles: readonly AccessRole[];
  /**
   * Чей объект спрашивает экран.
   *
   * `self` — раздел про свои данные: жилец спрашивает про себя, и право
   * с областью `self` его пускает. `house` — раздел про других: список
   * жильцов, карточка, учётные записи. Разница не косметическая: `user.read`
   * у жильца есть с областью `self`, и если спросить его «про себя»,
   * список жильцов дома откроется тому, кому не положен.
   */
  target: 'self' | 'house';
  /** Почему так: строка попадает в таблицу документации. */
  why: string;
}

const ALL: readonly AccessRole[] = ['resident', 'admin', 'superadmin'];
const STAFF: readonly AccessRole[] = ['admin', 'superadmin'];
const OWNER: readonly AccessRole[] = ['superadmin'];

export const ROUTE_ACCESS: readonly RouteAccess[] = [
  { route: '/', target: 'self', action: null, roles: ALL, why: 'дэшборд собирается по роли' },
  { route: '/profile', target: 'self', action: null, roles: ALL, why: 'свой профиль' },
  { route: '/notifications', target: 'self', action: null, roles: ALL, why: 'свои уведомления' },
  {
    route: '/contract',
    target: 'self',
    action: null,
    roles: ALL,
    why: 'жилец подписывает, админ собирает; чтение готового договора — отдельное полномочие (D28)',
  },
  {
    route: '/absences',
    target: 'self',
    action: 'absence.read',
    roles: ALL,
    why: 'жилец видит свои заявки',
  },
  {
    route: '/deposit',
    target: 'self',
    action: 'deposit.read',
    roles: ALL,
    why: 'жилец видит свой депозит',
  },
  {
    route: '/documents',
    target: 'self',
    action: null,
    roles: ALL,
    why: 'жилец грузит свои; доступ админа к документам — отключаемое полномочие сети (D28), и экран объясняет отсутствие очереди сам',
  },
  {
    route: '/invoices',
    target: 'self',
    action: 'invoice.read',
    roles: ALL,
    why: 'жилец видит свои счета',
  },
  {
    route: '/invoices/[id]',
    target: 'self',
    action: 'invoice.read',
    roles: ALL,
    why: 'свой счёт по ссылке',
  },
  {
    route: '/rotations',
    target: 'self',
    action: 'rotation.read',
    roles: ALL,
    why: 'жилец видит свои ротации',
  },
  {
    route: '/rating',
    target: 'self',
    action: 'rating.read',
    roles: ALL,
    why: 'жильцу — число без детализации',
  },
  {
    route: '/rating/[userId]',
    target: 'self',
    action: 'rating.read',
    roles: ALL,
    why: 'своя карточка рейтинга',
  },
  { route: '/beds', target: 'self', action: 'bed.read', roles: ALL, why: 'жилец видит своё место' },
  {
    route: '/utilities',
    target: 'self',
    action: null,
    roles: ALL,
    why: 'у жильца своя раскладка доли, у админа — период дома',
  },
  {
    route: '/damages',
    target: 'self',
    action: null,
    roles: ALL,
    why: 'у жильца свои списания, у админа — проведение ущерба',
  },
  {
    route: '/settings',
    target: 'self',
    action: null,
    roles: ALL,
    why: 'карточки раздела фильтруются правами',
  },
  {
    route: '/settings/personal',
    target: 'self',
    action: null,
    roles: ALL,
    why: 'свои язык и тема',
  },

  { route: '/residents', target: 'house', action: 'user.read', roles: STAFF, why: 'жильцы дома' },
  {
    route: '/residents/[id]',
    target: 'house',
    action: 'user.read',
    roles: STAFF,
    why: 'карточка жильца',
  },
  {
    route: '/inventory',
    target: 'house',
    action: 'inventory.read',
    roles: STAFF,
    why: 'инвентарь дома',
  },
  {
    route: '/invoices/remote',
    target: 'house',
    action: 'invoice.issue',
    roles: STAFF,
    why: 'удалёнка',
  },
  {
    route: '/rotations/stats',
    target: 'house',
    action: 'rotation.score',
    roles: STAFF,
    why: 'статистика ротаций',
  },
  {
    route: '/settings/users',
    target: 'house',
    action: 'user.read',
    roles: STAFF,
    why: 'учётные записи дома',
  },
  {
    route: '/settings/house',
    target: 'house',
    action: 'settings.house.read',
    roles: STAFF,
    why: 'настройки дома',
  },
  {
    route: '/settings/house/rotations',
    target: 'house',
    action: 'settings.house.read',
    roles: STAFF,
    why: 'ряды и нормы дома',
  },

  {
    route: '/accounting',
    target: 'house',
    action: 'accounting.read',
    roles: OWNER,
    why: 'бухгалтерию ведёт сеть',
  },
  {
    route: '/settings/houses',
    target: 'house',
    action: 'house.create',
    roles: OWNER,
    why: 'дома сети',
  },
  {
    route: '/settings/audit',
    target: 'house',
    action: 'audit.read',
    roles: OWNER,
    why: 'журнал сети',
  },
  {
    route: '/settings/network',
    target: 'house',
    action: 'settings.org.read',
    roles: OWNER,
    why: 'настройки сети',
  },
  {
    route: '/settings/document-types',
    target: 'house',
    action: 'settings.org.read',
    roles: OWNER,
    why: 'типы документов сети',
  },
  {
    route: '/settings/accounts',
    target: 'house',
    action: 'settings.org.read',
    roles: OWNER,
    why: 'план счетов',
  },
  {
    route: '/settings/contract-template',
    target: 'house',
    action: 'settings.org.read',
    roles: OWNER,
    why: 'шаблон договора',
  },
  {
    route: '/settings/profile-fields',
    target: 'house',
    action: 'settings.org.read',
    roles: OWNER,
    why: 'дополнительные поля профиля',
  },
  {
    route: '/settings/api-tokens',
    target: 'house',
    action: 'settings.org.read',
    roles: OWNER,
    why: 'токены API',
  },
  {
    route: '/settings/rating',
    target: 'house',
    action: 'rating.rules',
    roles: OWNER,
    why: 'правила рейтинга',
  },
];

export function accessOf(route: string): RouteAccess | undefined {
  return ROUTE_ACCESS.find((entry) => entry.route === route);
}
