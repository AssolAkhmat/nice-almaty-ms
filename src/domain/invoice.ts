/**
 * Счёт и остаток депозита (docs/02-DATA-MODEL.md, docs/03-BUSINESS-RULES.md §3).
 *
 * В фазе 2 нужен ровно депозитный счёт: месячная генерация, коммуналка,
 * штрафы и скидки — фаза 3. Здесь только то, что уже требуется заселению,
 * и написано так, чтобы фаза 3 это не переписывала, а дополняла.
 *
 * Деньги — целые тенге (D9), поэтому никаких дробей и округлений тут нет.
 */

/** Статусы из §3, доступные депозитному счёту в фазе 2. */
export type PaidStatus = 'issued' | 'partially_paid' | 'paid';

/** Остаток депозита — сумма движений со знаком (docs/02-DATA-MODEL.md). */
export function depositBalance(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}

/**
 * Статус счёта по внесённым платежам. Частичная оплата разрешена (§3):
 * предоплата в конце октября и доплата 1 ноября — обычный случай.
 */
export function invoiceStatus(total: number, paid: number): PaidStatus {
  if (paid >= total) {
    return 'paid';
  }

  return paid > 0 ? 'partially_paid' : 'issued';
}

/** Сколько осталось внести. Переплата не делает остаток отрицательным. */
export function remainingToPay(total: number, paid: number): number {
  return Math.max(0, total - paid);
}
