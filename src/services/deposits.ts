import { getDb, type Executor } from '@/db/client';
import {
  addInvoiceLines,
  createDepositTransaction,
  createInvoice,
  createPayment,
  listDepositTransactions,
  listInvoiceLines,
  listInvoices,
  listPayments,
  requireInvoice,
  updateInvoice,
} from '@/db/repositories/invoices';
import { countDamageShares } from '@/db/repositories/damages';
import { requireResidency, updateResidency } from '@/db/repositories/residencies';
import { depositBalance, invoiceStatus, remainingToPay } from '@/domain/invoice';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { now, startOfDayUtc, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { postDepositPayment } from './ledger';
import { readHouseDepositDefault } from './settings';

import type { DepositTransaction, Invoice, InvoiceLine, Payment, Residency } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Депозит и счёт на него (docs/03-BUSINESS-RULES.md §1.2 п.7–8, §2).
 *
 * Из всей машинерии счетов в фазе 2 работает только депозитный счёт:
 * месячная генерация, коммуналка и штрафы — фаза 3. Оплата депозита —
 * событие заселения: она переводит проживание в `active` и задаёт
 * `move_in_date` датой оплаты.
 */
export interface DepositDeps {
  executor?: Executor;
  today?: BusinessDate;
}

function resolve(deps: DepositDeps): { executor: Executor; today: BusinessDate } {
  return { executor: deps.executor ?? getDb(), today: deps.today ?? todayInAlmaty() };
}

export interface DepositInvoiceInput {
  /** Пусто — берётся значение дома по умолчанию (§1.2 п.7). */
  amount?: number | undefined;
  /** Дополнительные строки: например, доплата за дни до 1 числа. */
  extraLines?: readonly { title: string; amount: number }[] | undefined;
  note?: string | undefined;
}

export interface DepositView {
  residency: Residency;
  balance: number;
  transactions: DepositTransaction[];
  /**
   * Сколько человек делили ущерб — по идентификатору движения (§8, модуль 7).
   * Только для списаний и сторно ущерба; у остальных движений ключа нет.
   */
  participantsOf: Record<string, number>;
  invoice: (Invoice & { paid: number; remaining: number; lines: InvoiceLine[] }) | null;
}

/** Число участников по каждому движению, порождённому ущербом. */
async function participantsOf(
  transactions: readonly DepositTransaction[],
  executor: Executor,
): Promise<Record<string, number>> {
  const damageIds = transactions
    .filter((transaction) => transaction.refType === 'damage' && transaction.refId !== null)
    .map((transaction) => transaction.refId ?? '');

  const counts = await countDamageShares([...new Set(damageIds)], executor);
  const result: Record<string, number> = {};

  for (const transaction of transactions) {
    const count = transaction.refId === null ? undefined : counts.get(transaction.refId);

    if (count !== undefined) {
      result[transaction.id] = count;
    }
  }

  return result;
}

export interface PaymentInput {
  amount: number;
  method: Payment['method'];
  note?: string | undefined;
}

function assertMoney(amount: number): void {
  // Деньги — целые тенге (D9): дробь сюда попасть не должна вовсе.
  if (!Number.isInteger(amount) || amount < 0) {
    throw new ValidationError('deposits.amountInvalid');
  }
}

/**
 * Счёт на депозит. Повторно не выставляется: два счёта на один депозит
 * означали бы два разных ответа на вопрос «сколько внести».
 */
export async function issueDepositInvoice(
  actor: UserActor,
  residencyId: string,
  input: DepositInvoiceInput = {},
  deps: DepositDeps = {},
): Promise<Invoice> {
  const { executor, today } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'invoice.issue', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  const existing = await listInvoices(actor.context, { residencyId, type: 'deposit' }, executor);

  if (existing.some((invoice) => invoice.status !== 'cancelled')) {
    throw new ConflictError('Счёт на депозит уже выставлен');
  }

  const depositAmount =
    input.amount ?? (await readHouseDepositDefault(actor, residency.houseId, executor));
  assertMoney(depositAmount);

  const extraLines = input.extraLines ?? [];
  for (const line of extraLines) {
    assertMoney(line.amount);
  }

  const total = depositAmount + extraLines.reduce((sum, line) => sum + line.amount, 0);

  return executor.transaction(async (tx) => {
    const invoice = await createInvoice(
      actor.context,
      {
        houseId: residency.houseId,
        userId: residency.userId,
        residencyId: residency.id,
        type: 'deposit',
        status: 'issued',
        total,
        issuedAt: now(),
        dueDate: today,
        note: input.note ?? null,
        createdBy: actor.context.userId,
      },
      tx,
    );

    await addInvoiceLines(
      [
        { invoiceId: invoice.id, kind: 'deposit', title: 'Депозит', amount: depositAmount },
        ...extraLines.map((line) => ({
          invoiceId: invoice.id,
          kind: 'extra' as const,
          title: line.title,
          amount: line.amount,
        })),
      ],
      tx,
    );

    await updateResidency(
      actor.context,
      residency.id,
      { depositAmount, depositDueDate: today },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.invoiceIssued,
        entityType: 'invoice',
        entityId: invoice.id,
        after: { type: 'deposit', total, residencyId: residency.id },
      },
      tx,
    );

    return invoice;
  });
}

/** Сумма строк депозита: на депозитный счёт жильца идёт именно она. */
function depositPart(lines: readonly InvoiceLine[]): number {
  return lines
    .filter((line) => line.kind === 'deposit')
    .reduce((sum, line) => sum + line.amount, 0);
}

/**
 * Платёж по счёту. Когда депозитный счёт закрыт полностью, срабатывает
 * шаг 8 заселения: депозит зачисляется, проживание становится `active`,
 * `move_in_date` — дата оплаты, а не дата подписания договора.
 */
export async function recordPayment(
  actor: UserActor,
  invoiceId: string,
  input: PaymentInput,
  deps: DepositDeps = {},
): Promise<Invoice> {
  const { executor, today } = resolve(deps);

  const invoice = await requireInvoice(actor.context, invoiceId, executor);
  const residency = await requireResidency(actor.context, invoice.residencyId, executor);

  assertCan(actor.context, 'payment.record', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  assertMoney(input.amount);
  if (input.amount === 0) {
    throw new ValidationError('deposits.amountInvalid');
  }

  if (invoice.status === 'cancelled') {
    throw new ConflictError('Счёт отменён');
  }

  const previous = await listPayments(invoice.id, executor);
  const paidBefore = previous.reduce((sum, payment) => sum + payment.amount, 0);

  // Переплата запрещена без явного решения (инвариант 6 из 02-DATA-MODEL.md).
  if (paidBefore + input.amount > invoice.total) {
    throw new ValidationError('deposits.overpayment', {
      remaining: remainingToPay(invoice.total, paidBefore),
    });
  }

  return executor.transaction(async (tx) => {
    await createPayment(
      {
        invoiceId: invoice.id,
        amount: input.amount,
        method: input.method,
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

    if (invoice.type !== 'deposit' || status !== 'paid') {
      return updated;
    }

    const lines = await listInvoiceLines(invoice.id, tx);
    const charge = depositPart(lines);

    /*
     * Деньги входят в книгу тем же движением, что и на депозитный счёт
     * жильца (§10.1, инвариант 4). Проводка идёт по полной оплате, а не
     * по каждому платежу: до неё депозит депозитом не стал — §1.2 п.8
     * не считает жильца заселённым, и остаток фонда разошёлся бы
     * с суммой депозитов ровно на недоплату.
     */
    await postDepositPayment(
      actor,
      {
        houseId: residency.houseId,
        invoiceId: invoice.id,
        method: input.method,
        deposit: charge,
        other: invoice.total - charge,
        date: today,
      },
      { executor: tx, today },
    );

    await createDepositTransaction(
      actor.context,
      {
        residencyId: residency.id,
        type: 'charge',
        amount: charge,
        refType: 'invoice',
        refId: invoice.id,
        note: 'Оплата депозита',
        createdBy: actor.context.userId,
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.depositCharged,
        entityType: 'residency',
        entityId: residency.id,
        after: { amount: charge, invoiceId: invoice.id },
      },
      tx,
    );

    /*
     * Шаг 8 §1.2: до оплаты депозита жилец не заселён. Дата заезда — день
     * оплаты, а не день подписания договора и не день назначения места.
     */
    if (residency.status !== 'active') {
      await updateResidency(
        actor.context,
        residency.id,
        { status: 'active', moveInDate: today },
        tx,
      );

      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.residencyActivated,
          entityType: 'residency',
          entityId: residency.id,
          before: { status: residency.status },
          after: { status: 'active', moveInDate: today },
        },
        tx,
      );
    }

    return updated;
  });
}

/** Экран «Мой депозит»: остаток, движение за год и счёт на депозит. */
export async function readDepositView(
  actor: UserActor,
  residencyId: string,
  options: { year?: number } = {},
  deps: DepositDeps = {},
): Promise<DepositView> {
  const { executor, today } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'deposit.read', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  const year = options.year ?? Number(today.slice(0, 4));
  const from = startOfDayUtc(`${String(year)}-01-01` as BusinessDate);
  const to = startOfDayUtc(`${String(year + 1)}-01-01` as BusinessDate);

  const [transactions, invoicesOfResidency] = await Promise.all([
    listDepositTransactions(actor.context, residency.id, { from, to }, executor),
    listInvoices(actor.context, { residencyId: residency.id, type: 'deposit' }, executor),
  ]);

  const [invoice] = invoicesOfResidency;

  if (invoice === undefined) {
    return {
      residency,
      // Остаток считается по всем движениям, а не по показанному году.
      balance: depositBalance(
        (await listDepositTransactions(actor.context, residency.id, {}, executor)).map(
          (transaction) => transaction.amount,
        ),
      ),
      transactions,
      participantsOf: await participantsOf(transactions, executor),
      invoice: null,
    };
  }

  const [lines, paymentsOfInvoice, allTransactions] = await Promise.all([
    listInvoiceLines(invoice.id, executor),
    listPayments(invoice.id, executor),
    listDepositTransactions(actor.context, residency.id, {}, executor),
  ]);

  const paid = paymentsOfInvoice.reduce((sum, payment) => sum + payment.amount, 0);

  return {
    residency,
    balance: depositBalance(allTransactions.map((transaction) => transaction.amount)),
    transactions,
    participantsOf: await participantsOf(transactions, executor),
    invoice: { ...invoice, paid, remaining: remainingToPay(invoice.total, paid), lines },
  };
}
