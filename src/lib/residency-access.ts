/**
 * Жёсткая блокировка модулей до оплаты депозита (§1.2).
 *
 * «До шага 8 жильцу доступны только: профиль, документы, свои счета.
 * Ротации, отсутствия, дэшборд-модули закрыты.» Договор и депозит в этом
 * списке не названы, но без них шаги 5 и 8 закрыть нечем — иначе правило
 * запрещало бы само заселение.
 *
 * Чистая функция: ни БД, ни сессии. Решение принимает layout защищённой зоны.
 */
const ALLOWED_PREFIXES = [
  '/profile',
  '/documents',
  '/contract',
  '/deposit',
  '/invoices',
  '/settings/personal',
] as const;

/** Дэшборд открыт всем: на нём и живёт сам мастер заселения. */
const DASHBOARD = '/';

export function isAllowedDuringOnboarding(pathname: string): boolean {
  if (pathname === DASHBOARD) {
    return true;
  }

  return ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
