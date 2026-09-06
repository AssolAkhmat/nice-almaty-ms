import type { Residency } from '@/db/schema';

/**
 * Что открыто жильцу на разных этапах жизни проживания.
 *
 * До оплаты депозита действует жёсткая блокировка §1.2: «до шага 8 жильцу
 * доступны только профиль, документы, свои счета. Ротации, отсутствия,
 * дэшборд-модули закрыты». Договор и депозит в этом списке не названы,
 * но без них шаги 5 и 8 закрыть нечем — иначе правило запрещало бы
 * само заселение.
 *
 * После расторжения (§2.3 п.2) остаётся ещё меньше: «закрыты все модули,
 * кроме профиля и движения депозита. Вход сохраняется». Документы, договор
 * и счета закрываются вместе со всем остальным; счёт возврата виден
 * на экране депозита, поэтому жилец не теряет из виду свои деньги.
 *
 * Чистая функция: ни БД, ни сессии. Решение принимает layout защищённой зоны.
 */
export type ResidencyAccessScope = 'onboarding' | 'termination' | 'full';

const ONBOARDING_PREFIXES = [
  '/profile',
  '/documents',
  '/contract',
  '/deposit',
  '/invoices',
  '/settings/personal',
] as const;

/**
 * Личные настройки открыты и здесь: смена пароля, языка и темы — часть
 * сохранённого входа, а не модуль. Отобрать их значило бы оставить жильца
 * с логином, который он не может обслуживать (P2-33).
 */
const TERMINATION_PREFIXES = ['/profile', '/deposit', '/settings/personal'] as const;

/** Дэшборд открыт всегда: на нём живёт мастер заселения и сводка выселения. */
const DASHBOARD = '/';

export function accessScopeOf(status: Residency['status'] | null): ResidencyAccessScope {
  if (status === 'terminating' || status === 'archived') {
    return 'termination';
  }

  return status === 'active' ? 'full' : 'onboarding';
}

export function isPathAllowed(scope: ResidencyAccessScope, pathname: string): boolean {
  if (scope === 'full' || pathname === DASHBOARD) {
    return true;
  }

  const prefixes = scope === 'termination' ? TERMINATION_PREFIXES : ONBOARDING_PREFIXES;

  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
