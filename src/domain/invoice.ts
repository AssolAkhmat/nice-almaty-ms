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

/**
 * Куда попадает платёж в книге проводок (§10.1): коммунальный фонд,
 * депозитный фонд или фонд дома.
 */
export type FundGroup = 'utilities' | 'deposit' | 'house';

/** Вид строки счёта — из `invoice_line_kind` модели данных. */
export type InvoiceLineKind =
  | 'rent'
  | 'utilities'
  | 'fine'
  | 'damage_carryover'
  | 'extra'
  | 'deposit'
  | 'discount'
  | 'proration';

export interface LineAmount {
  kind: InvoiceLineKind;
  amount: number;
}

export type PaymentAllocation = Record<FundGroup, number>;

/**
 * Порядок закрытия строк платежом. Коммуналка первой: это деньги поставщика,
 * и застревать в фонде дома им незачем. Следом перерасход депозита —
 * пока он не погашен, остаток жильца отрицателен и попадёт в следующий счёт
 * второй раз (§2.4). Остальное — фонд дома.
 */
const GROUP_ORDER: readonly FundGroup[] = ['utilities', 'deposit', 'house'];

function groupOf(kind: InvoiceLineKind): FundGroup {
  if (kind === 'utilities') {
    return 'utilities';
  }

  return kind === 'damage_carryover' ? 'deposit' : 'house';
}

/**
 * Как разнести платёж по фондам. Частичная оплата разрешена (§3), поэтому
 * разнесение идёт в постоянном порядке, а не пропорционально: доли от целых
 * тенге пришлось бы округлять, и проводка переставала бы сходиться.
 *
 * Сумма разнесённого всегда равна платежу — на этом стоит равенство дебета
 * и кредита (инвариант 3).
 */
export function allocatePayment(
  lines: readonly LineAmount[],
  paidBefore: number,
  amount: number,
): PaymentAllocation {
  const totals: PaymentAllocation = { utilities: 0, deposit: 0, house: 0 };

  for (const line of lines) {
    totals[groupOf(line.kind)] += line.amount;
  }

  const allocation: PaymentAllocation = { utilities: 0, deposit: 0, house: 0 };

  let skip = paidBefore;
  let left = amount;

  for (const group of GROUP_ORDER) {
    // Отрицательный итог группы (скидка, §5.4) закрывать нечем: он пропускается.
    const available = Math.max(0, totals[group]);
    const consumed = Math.min(skip, available);

    skip -= consumed;

    const take = Math.min(left, available - consumed);
    allocation[group] += take;
    left -= take;
  }

  // Остаток бывает, когда строки не покрывают платёж: он идёт в фонд дома,
  // иначе проводка оказалась бы меньше полученных денег.
  allocation.house += left;

  return allocation;
}
