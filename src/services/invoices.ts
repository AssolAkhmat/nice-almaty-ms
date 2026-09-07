import { getDb, type Executor } from '@/db/client';
import { parsePeriod } from '@/db/period';
import {
  addInvoiceLines,
  createDepositTransaction,
  createInvoice as insertInvoice,
  createPayment,
  listDepositTransactions,
  listInvoiceLines,
  listInvoices,
  listPayments,
  paidTotals,
  replaceInvoiceLines,
  requireInvoice,
  updateInvoice,
  type InvoiceFilter,
} from '@/db/repositories/invoices';
import { listAssignments, requireResidency } from '@/db/repositories/residencies';
import { findClosedAllocation } from '@/db/repositories/utilities';
import {
  allocatePayment,
  depositBalance,
  invoiceStatus,
  remainingToPay,
  type InvoiceLineKind,
} from '@/domain/invoice';
import { rentForMonth } from '@/domain/monthly-invoice';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import {
  addMonths,
  compareBusinessDates,
  now,
  parseBusinessDate,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { settleDepositInvoice } from './deposits';
import { postInvoicePayment } from './ledger';

import type { AccessContext } from '@/db/access';
import type { Invoice, InvoiceLine, Payment, Residency } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Счета, строки и платежи (docs/03-BUSINESS-RULES.md §3,
 * docs/04-MODULES/02-places-and-payments.md, «Счета»).
 *
 * Здесь единственный путь платежа — любого, включая депозитный: правило
 * «переплата запрещена» (инвариант 6) и статус счёта не должны существовать
 * в двух экземплярах. Что делает оплата депозита сверх этого — заселение
 * по §1.2 п.8 — остаётся в `deposits.ts` и вызывается отсюда.
 *
 * Итог счёта нигде не приходит числом со стороны: он всегда сумма строк
 * (инвариант 5), поэтому и правка строк, и пересчёт заканчиваются
 * пересборкой итога.
 */
export interface InvoiceDeps {
  executor?: Executor;
  today?: BusinessDate;
  /** Момент действия; из него выводится и «сегодня», и дата платежа. */
  instant?: Date;
}

function resolve(deps: InvoiceDeps): {
  executor: Executor;
  today: BusinessDate;
  instant: Date;
} {
  const instant = deps.instant ?? now();

  return {
    executor: deps.executor ?? getDb(),
    today: deps.today ?? todayInAlmaty(instant),
    instant,
  };
}

export interface InvoiceLineInput {
  kind: InvoiceLineKind;
  title: string;
  amount: number;
}

export interface CreateInvoiceInput {
  residencyId: string;
  /** Депозит выставляется своим путём (`deposits.ts`), возврат — своим. */
  type: 'monthly' | 'extra';
  /** Первое число месяца, к которому относится счёт (§3). */
  periodMonth?: BusinessDate | undefined;
  dueDate?: BusinessDate | undefined;
  note?: string | null | undefined;
  /** Кто выставил. `null` — счёт создан расписанием, а не человеком (§3). */
  createdBy?: string | null | undefined;
  lines: readonly InvoiceLineInput[];
}

export interface PaymentInput {
  amount: number;
  method: Payment['method'];
  /**
   * Когда деньги получены (модуль 2, «Отметка оплаты: сумма, способ, дата»).
   * Пусто — момент отметки. Дата платежа — данные, а не отпечаток часов
   * базы: по ней считается и оборот эквайринга за период (§10.2).
   */
  paidAt?: Date | undefined;
  note?: string | undefined;
}

export interface InvoiceRow {
  invoice: Invoice;
  paid: number;
  remaining: number;
  /** Флаг «Долг» §3: срок прошёл, а счёт не закрыт. На рейтинг не влияет. */
  overdue: boolean;
}

export interface InvoiceView extends InvoiceRow {
  lines: InvoiceLine[];
  payments: Payment[];
}

/** Порядок строк в счёте — тот же, что в таблице состава §3. */
const KIND_ORDER: readonly InvoiceLineKind[] = [
  'rent',
  'utilities',
  'fine',
  'damage_carryover',
  'proration',
  'extra',
  'discount',
  'deposit',
];

/**
 * Строки, которые «Пересчитать» перестраивает по актуальным данным
 * (модуль 2). Штрафы и скидка сюда попадут вместе со своим источником —
 * рейтингом (фаза 5); пока его нет, пересчёт их не трогает, иначе он стирал
 * бы то, чего не умеет восстановить.
 */
const REBUILT_KINDS: readonly InvoiceLineKind[] = ['rent', 'utilities', 'damage_carryover'];

/**
 * Строка коммуналки для счёта за месяц: доля берётся из закрытого периода
 * **прошлого** месяца (§3 — коммуналка идёт за прошлый месяц, §4).
 * `null` — период не закрыт или жилец в нём не участвовал.
 */
export async function utilitiesLineFor(
  context: AccessContext,
  target: { houseId: string; userId: string; invoiceMonth: BusinessDate },
  executor: Executor,
): Promise<InvoiceLineInput | null> {
  const month = addMonths(target.invoiceMonth, -1);

  const allocation = await findClosedAllocation(
    context,
    { houseId: target.houseId, month, userId: target.userId },
    executor,
  );

  if (allocation === null || allocation.amount <= 0) {
    return null;
  }

  return {
    kind: 'utilities',
    title: `Коммунальные услуги за ${month.slice(0, 7)}`,
    amount: allocation.amount,
  };
}

function assertMoney(amount: number): void {
  // Деньги — целые тенге (§0). Дробь сюда попасть не должна вовсе.
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new ValidationError('invoices.errors.amountInvalid');
  }
}

function assertLines(lines: readonly InvoiceLineInput[]): void {
  if (lines.length === 0) {
    throw new ValidationError('invoices.errors.noLines');
  }

  for (const line of lines) {
    assertMoney(line.amount);

    if (line.title.trim() === '') {
      throw new ValidationError('invoices.errors.titleRequired');
    }
  }
}

function totalOf(lines: readonly { amount: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amount, 0);
}

function sortLines(lines: readonly InvoiceLineInput[]): InvoiceLineInput[] {
  return [...lines].sort((left, right) => {
    return KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
  });
}

function isOverdue(invoice: Invoice, paid: number, today: BusinessDate): boolean {
  if (invoice.dueDate === null || paid >= invoice.total) {
    return false;
  }

  if (invoice.status === 'cancelled' || invoice.status === 'paid') {
    return false;
  }

  return compareBusinessDates(parseBusinessDate(invoice.dueDate), today) < 0;
}

/** Счёт вместе с проживанием: права на счёт — это права на его жильца. */
async function invoiceWithResidency(
  actor: UserActor,
  invoiceId: string,
  action: 'invoice.read' | 'invoice.issue' | 'payment.record',
  executor: Executor,
): Promise<{ invoice: Invoice; residency: Residency }> {
  const invoice = await requireInvoice(actor.context, invoiceId, executor);
  const residency = await requireResidency(actor.context, invoice.residencyId, executor);

  assertCan(actor.context, action, { houseId: residency.houseId, userId: residency.userId });

  return { invoice, residency };
}

/**
 * Ручной счёт (модуль 2): тип, строки, срок оплаты, комментарий.
 * Автогенерация 1 числа приходит сюда же в T3.6 — состав строк собирает
 * `src/domain/monthly-invoice.ts`, а запись счёта живёт здесь.
 */
export async function createInvoice(
  actor: UserActor,
  input: CreateInvoiceInput,
  deps: InvoiceDeps = {},
): Promise<Invoice> {
  const { executor, today } = resolve(deps);

  const residency = await requireResidency(actor.context, input.residencyId, executor);
  assertCan(actor.context, 'invoice.issue', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  assertLines(input.lines);

  const lines = sortLines(input.lines);
  const total = totalOf(lines);

  return executor.transaction(async (tx) => {
    const invoice = await insertInvoice(
      actor.context,
      {
        houseId: residency.houseId,
        userId: residency.userId,
        residencyId: residency.id,
        type: input.type,
        periodMonth: input.periodMonth ?? null,
        // Счёт на ноль тенге закрыт сразу: платить по нему нечего.
        status: invoiceStatus(total, 0),
        total,
        issuedAt: now(),
        dueDate: input.dueDate ?? input.periodMonth ?? today,
        note: input.note ?? null,
        createdBy: input.createdBy === undefined ? actor.context.userId : input.createdBy,
      },
      tx,
    );

    await addInvoiceLines(
      lines.map((line) => ({
        invoiceId: invoice.id,
        kind: line.kind,
        title: line.title.trim(),
        amount: line.amount,
      })),
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.invoiceIssued,
        entityType: 'invoice',
        entityId: invoice.id,
        after: { type: input.type, total, residencyId: residency.id },
      },
      tx,
    );

    return invoice;
  });
}

/**
 * Правка строк до полной оплаты (модуль 2). После оплаты счёт не меняется:
 * жилец заплатил по тому, что видел, и переписывать основание задним числом
 * нельзя — остаются сторно и новый счёт.
 */
export async function editInvoiceLines(
  actor: UserActor,
  invoiceId: string,
  lines: readonly InvoiceLineInput[],
  deps: InvoiceDeps = {},
): Promise<Invoice> {
  const { executor } = resolve(deps);

  const { invoice } = await invoiceWithResidency(actor, invoiceId, 'invoice.issue', executor);

  if (invoice.status === 'paid' || invoice.status === 'cancelled') {
    throw new ConflictError('invoices.errors.closed');
  }

  assertLines(lines);

  const sorted = sortLines(lines);
  const total = totalOf(sorted);

  const paid = totalOf(await listPayments(invoice.id, executor));

  // Инвариант 6 наоборот: итог не должен опуститься ниже уже внесённого.
  if (total < paid) {
    throw new ValidationError('invoices.errors.belowPaid', { paid });
  }

  return executor.transaction(async (tx) => {
    await replaceInvoiceLines(
      invoice.id,
      sorted.map((line) => ({
        kind: line.kind,
        title: line.title.trim(),
        amount: line.amount,
      })),
      tx,
    );

    const updated = await updateInvoice(
      actor.context,
      invoice.id,
      { total, status: invoiceStatus(total, paid) },
      tx,
    );

    if (updated === null) {
      throw new NotFoundError('Счёт не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.invoiceEdited,
        entityType: 'invoice',
        entityId: invoice.id,
        before: { total: invoice.total },
        after: { total, lines: sorted.length },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Дописать строку в уже выставленный счёт. Нужно коммуналке: период,
 * закрытый после 1 числа, добавляет долю в счёт того же месяца (§4).
 * Оплаченный счёт не трогается — платить по нему уже нечего, и доля
 * уходит отдельным счётом (решение вызывающей стороны).
 */
export async function appendInvoiceLine(
  actor: UserActor,
  invoiceId: string,
  line: InvoiceLineInput,
  deps: InvoiceDeps = {},
): Promise<{ invoice: Invoice; line: InvoiceLine }> {
  const { executor } = resolve(deps);

  const { invoice } = await invoiceWithResidency(actor, invoiceId, 'invoice.issue', executor);

  if (invoice.status === 'paid' || invoice.status === 'cancelled') {
    throw new ConflictError('invoices.errors.closed');
  }

  assertLines([line]);

  return executor.transaction(async (tx) => {
    const [added] = await addInvoiceLines(
      [
        {
          invoiceId: invoice.id,
          kind: line.kind,
          title: line.title.trim(),
          amount: line.amount,
        },
      ],
      tx,
    );

    if (added === undefined) {
      throw new ConflictError('invoices.errors.notUpdated');
    }

    const total = invoice.total + line.amount;
    const paid = totalOf(await listPayments(invoice.id, tx));

    const updated = await updateInvoice(
      actor.context,
      invoice.id,
      { total, status: invoiceStatus(total, paid) },
      tx,
    );

    if (updated === null) {
      throw new NotFoundError('Счёт не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.invoiceEdited,
        entityType: 'invoice',
        entityId: invoice.id,
        before: { total: invoice.total },
        after: { total, added: line.kind },
      },
      tx,
    );

    return { invoice: updated, line: added };
  });
}

/**
 * Отмена счёта. Только пока по нему ничего не внесено: отменённый счёт
 * с платежом оставил бы деньги без основания, а вернуть их отменой нельзя —
 * для этого есть сторно проводки и новый счёт.
 */
export async function cancelInvoice(
  actor: UserActor,
  invoiceId: string,
  deps: InvoiceDeps = {},
): Promise<Invoice> {
  const { executor } = resolve(deps);

  const { invoice } = await invoiceWithResidency(actor, invoiceId, 'invoice.issue', executor);

  if (invoice.status === 'cancelled') {
    throw new ConflictError('invoices.errors.alreadyCancelled');
  }

  const paid = totalOf(await listPayments(invoice.id, executor));
  if (paid > 0) {
    throw new ConflictError('invoices.errors.paidCannotCancel');
  }

  return executor.transaction(async (tx) => {
    const updated = await updateInvoice(actor.context, invoice.id, { status: 'cancelled' }, tx);
    if (updated === null) {
      throw new NotFoundError('Счёт не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.invoiceCancelled,
        entityType: 'invoice',
        entityId: invoice.id,
        before: { status: invoice.status },
        after: { status: 'cancelled' },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Платёж по счёту — единственный путь для всех типов счетов (§3).
 * Частичная оплата разрешена, переплата запрещена (инвариант 6).
 */
export async function recordPayment(
  actor: UserActor,
  invoiceId: string,
  input: PaymentInput,
  deps: InvoiceDeps = {},
): Promise<Invoice> {
  const { executor, today, instant } = resolve(deps);

  const { invoice, residency } = await invoiceWithResidency(
    actor,
    invoiceId,
    'payment.record',
    executor,
  );

  assertMoney(input.amount);
  if (input.amount === 0) {
    throw new ValidationError('invoices.errors.amountInvalid');
  }

  if (invoice.status === 'cancelled') {
    throw new ConflictError('invoices.errors.cancelled');
  }

  /*
   * Счёт возврата депозита деньгами жильца не закрывается: он идёт
   * в обратную сторону и отмечается выплатой (`terminations.settleRefund`).
   */
  if (invoice.type === 'deposit_refund') {
    throw new ConflictError('invoices.errors.refundNotPayable');
  }

  const paidBefore = totalOf(await listPayments(invoice.id, executor));

  if (paidBefore + input.amount > invoice.total) {
    throw new ValidationError('invoices.errors.overpayment', {
      remaining: remainingToPay(invoice.total, paidBefore),
    });
  }

  const lines = await listInvoiceLines(invoice.id, executor);

  return executor.transaction(async (tx) => {
    await createPayment(
      {
        invoiceId: invoice.id,
        amount: input.amount,
        method: input.method,
        paidAt: input.paidAt ?? instant,
        recordedBy: actor.context.userId,
        note: input.note ?? null,
      },
      tx,
    );

    const paid = paidBefore + input.amount;
    const status = invoiceStatus(invoice.total, paid);

    const updated = await updateInvoice(actor.context, invoice.id, { status }, tx);
    if (updated === null) {
      throw new NotFoundError('Счёт не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.paymentRecorded,
        entityType: 'invoice',
        entityId: invoice.id,
        before: { status: invoice.status, paid: paidBefore },
        after: { status, paid, method: input.method },
      },
      tx,
    );

    if (invoice.type === 'deposit') {
      await settleDepositInvoice(actor, updated, residency, status, { executor: tx, today });

      return updated;
    }

    const allocation = allocatePayment(
      lines.map((line) => ({ kind: line.kind, amount: line.amount })),
      paidBefore,
      input.amount,
    );

    await postInvoicePayment(
      actor,
      {
        houseId: residency.houseId,
        invoiceId: invoice.id,
        method: input.method,
        allocation,
        date: todayInAlmaty(input.paidAt ?? instant),
      },
      { executor: tx, today },
    );

    /*
     * Погашение перерасхода депозита возвращает остаток жильца (§2.4):
     * без этого движения следующий месячный счёт начислил бы тот же долг
     * второй раз, а депозитный фонд разошёлся бы с суммой депозитов.
     */
    if (allocation.deposit > 0) {
      await createDepositTransaction(
        actor.context,
        {
          residencyId: residency.id,
          type: 'adjustment',
          amount: allocation.deposit,
          refType: 'invoice',
          refId: invoice.id,
          note: 'Погашение перерасхода депозита',
          createdBy: actor.context.userId,
        },
        tx,
      );
    }

    return updated;
  });
}

/**
 * «Пересчитать» (модуль 2): автоматические строки перестраиваются
 * по актуальным данным, ручные остаются как есть. Оплаченный счёт
 * не пересчитывается — основание платежа задним числом не меняется.
 */
export async function recalculateInvoice(
  actor: UserActor,
  invoiceId: string,
  deps: InvoiceDeps = {},
): Promise<Invoice> {
  const { executor } = resolve(deps);

  const { invoice, residency } = await invoiceWithResidency(
    actor,
    invoiceId,
    'invoice.issue',
    executor,
  );

  if (invoice.type !== 'monthly') {
    throw new ConflictError('invoices.errors.notMonthly');
  }

  if (invoice.status === 'paid' || invoice.status === 'cancelled') {
    throw new ConflictError('invoices.errors.closed');
  }

  if (invoice.periodMonth === null) {
    throw new ConflictError('invoices.errors.noPeriod');
  }

  const month = parseBusinessDate(invoice.periodMonth);

  const [existing, assignments, transactions] = await Promise.all([
    listInvoiceLines(invoice.id, executor),
    listAssignments(residency.id, executor),
    listDepositTransactions(actor.context, residency.id, {}, executor),
  ]);

  const rent = rentForMonth(
    month,
    assignments.map((assignment) => {
      const period = parsePeriod(assignment.period);

      return { price: assignment.price, from: period.from, to: period.to };
    }),
  );

  const balance = depositBalance(transactions.map((transaction) => transaction.amount));

  const rebuilt: InvoiceLineInput[] = [{ kind: 'rent', title: 'Проживание', amount: rent }];

  const utilities = await utilitiesLineFor(
    actor.context,
    { houseId: residency.houseId, userId: residency.userId, invoiceMonth: month },
    executor,
  );

  if (utilities !== null) {
    rebuilt.push(utilities);
  }

  if (balance < 0) {
    rebuilt.push({
      kind: 'damage_carryover',
      title: 'Погашение перерасхода депозита',
      amount: -balance,
    });
  }

  const kept = existing
    .filter((line) => !REBUILT_KINDS.includes(line.kind))
    .map((line) => ({ kind: line.kind, title: line.title, amount: line.amount }));

  return editInvoiceLines(actor, invoice.id, [...rebuilt, ...kept], deps);
}

/** Счёт со строками, платежами и остатком — экран жильца и карточка админа. */
export async function readInvoice(
  actor: UserActor,
  invoiceId: string,
  deps: InvoiceDeps = {},
): Promise<InvoiceView> {
  const { executor, today } = resolve(deps);

  const { invoice } = await invoiceWithResidency(actor, invoiceId, 'invoice.read', executor);

  const [lines, invoicePayments] = await Promise.all([
    listInvoiceLines(invoice.id, executor),
    listPayments(invoice.id, executor),
  ]);

  const paid = totalOf(invoicePayments);

  return {
    invoice,
    lines,
    payments: invoicePayments,
    paid,
    remaining: remainingToPay(invoice.total, paid),
    overdue: isOverdue(invoice, paid, today),
  };
}

/**
 * Список счетов: свои — жильцу, дома — админу, сети — суперадмину.
 * Внесённые суммы считаются одной выборкой, а не по счёту: таблица дома
 * за месяц иначе била бы базу по разу на строку.
 */
export async function listInvoicesFor(
  actor: UserActor,
  filter: InvoiceFilter = {},
  deps: InvoiceDeps = {},
): Promise<InvoiceRow[]> {
  const { executor, today } = resolve(deps);

  if (filter.residencyId !== undefined) {
    const residency = await requireResidency(actor.context, filter.residencyId, executor);
    assertCan(actor.context, 'invoice.read', {
      houseId: residency.houseId,
      userId: residency.userId,
    });
  } else if (filter.houseId !== undefined) {
    assertCan(actor.context, 'invoice.read', { houseId: filter.houseId });
  } else {
    assertCan(actor.context, 'invoice.read', { userId: actor.context.userId });
  }

  const rows = await listInvoices(actor.context, filter, executor);
  const paid = await paidTotals(
    rows.map((invoice) => invoice.id),
    executor,
  );

  return rows.map((invoice) => {
    const amount = paid.get(invoice.id) ?? 0;

    return {
      invoice,
      paid: amount,
      remaining: remainingToPay(invoice.total, amount),
      overdue: isOverdue(invoice, amount, today),
    };
  });
}
