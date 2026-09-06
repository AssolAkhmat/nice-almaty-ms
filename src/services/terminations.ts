import { getDb, type Executor } from '@/db/client';
import {
  createDepositTransaction,
  createInvoice,
  addInvoiceLines,
  listDepositTransactions,
  listInvoices,
  requireInvoice,
  updateInvoice,
} from '@/db/repositories/invoices';
import {
  findOpenAssignment,
  releaseBed,
  requireResidency,
  updateResidency,
} from '@/db/repositories/residencies';
import { countFullMonths, decideDepositOutcome, type DepositOutcome } from '@/domain/deposit';
import { depositBalance } from '@/domain/invoice';
import { daysUntilRefundDeadline, moveOutDateProblem, refundDeadline } from '@/domain/termination';
import { assertCan } from '@/lib/authz';
import { ConflictError, ValidationError } from '@/lib/errors';
import {
  compareBusinessDates,
  now,
  parseBusinessDate,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { DepositTransaction, Invoice, Residency } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Расторжение договора и возврат депозита
 * (docs/03-BUSINESS-RULES.md §2.2–2.4, docs/04-MODULES/01-onboarding.md).
 *
 * Дата выезда может быть в будущем: место освобождается с неё, а доступ
 * к модулям закрывается сразу. Счёт возврата собирается после расчёта —
 * до тех пор ущерб ещё можно проводить (§2.3 п.5).
 */
export interface TerminationDeps {
  executor?: Executor;
  /**
   * Момент действия. Из него же выводится сегодняшний день, поэтому
   * записанный в базу момент расторжения и отсчёт 30 дней от него
   * не могут разойтись.
   */
  instant?: Date;
  today?: BusinessDate;
}

function resolve(deps: TerminationDeps): {
  executor: Executor;
  instant: Date;
  today: BusinessDate;
} {
  const instant = deps.instant ?? now();

  return {
    executor: deps.executor ?? getDb(),
    instant,
    today: deps.today ?? todayInAlmaty(instant),
  };
}

export interface TerminateInput {
  moveOutDate: BusinessDate;
  /** Причина расторжения. Поля в модели нет — причина живёт в журнале (P2-34). */
  reason: string;
}

export interface TerminationView {
  residency: Residency;
  /** Остаток депозита со знаком: минус — перерасход по ущербу (§2.4). */
  balance: number;
  /** Сколько всего списано за ущерб, положительным числом. */
  damages: number;
  transactions: DepositTransaction[];
  fullMonths: number;
  /** Крайний срок возврата — 30 дней от расторжения. */
  deadline: BusinessDate | null;
  /** Дней до крайнего срока; отрицательное — просрочка. */
  daysLeft: number | null;
  outcome: DepositOutcome;
  refundInvoice: Invoice | null;
  canArchive: boolean;
}

/** Дата расторжения — день нажатия кнопки по календарю Алматы. */
function terminatedOn(residency: Residency): BusinessDate | null {
  return residency.terminationRequestedAt === null
    ? null
    : todayInAlmaty(residency.terminationRequestedAt);
}

function fullMonthsOf(residency: Residency): number {
  if (residency.moveInDate === null || residency.moveOutDate === null) {
    return 0;
  }

  return countFullMonths(
    parseBusinessDate(residency.moveInDate),
    parseBusinessDate(residency.moveOutDate),
  );
}

async function depositState(
  actor: UserActor,
  residencyId: string,
  executor: Executor,
): Promise<{ balance: number; damages: number; transactions: DepositTransaction[] }> {
  const transactions = await listDepositTransactions(actor.context, residencyId, {}, executor);

  const damages = transactions
    .filter(
      (transaction) =>
        transaction.type === 'damage_share' || transaction.type === 'damage_reversal',
    )
    .reduce((total, transaction) => total - transaction.amount, 0);

  return {
    balance: depositBalance(transactions.map((transaction) => transaction.amount)),
    damages,
    transactions,
  };
}

/** Действующий счёт возврата: отменённый в счёт не идёт. */
async function findRefundInvoice(
  actor: UserActor,
  residencyId: string,
  executor: Executor,
): Promise<Invoice | null> {
  const invoicesOfResidency = await listInvoices(
    actor.context,
    { residencyId, type: 'deposit_refund' },
    executor,
  );

  return invoicesOfResidency.find((invoice) => invoice.status !== 'cancelled') ?? null;
}

/**
 * Расторжение (§2.3 п.1–3). С этого момента статус `terminating`: закрыты
 * все модули, кроме профиля и движения депозита, а вход сохраняется.
 */
export async function terminateResidency(
  actor: UserActor,
  residencyId: string,
  input: TerminateInput,
  deps: TerminationDeps = {},
): Promise<Residency> {
  const { executor, instant, today } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'residency.terminate', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  /*
   * Расторгается договор заселённого жильца. Незаселённое проживание
   * расторгать нечем: там ещё нет ни договора, ни депозита, и закрывается
   * оно архивацией аккаунта (P2-35).
   */
  if (residency.status !== 'active') {
    throw new ConflictError('terminations.errors.notActive');
  }

  const problem = moveOutDateProblem({
    moveIn: residency.moveInDate === null ? null : parseBusinessDate(residency.moveInDate),
    moveOut: input.moveOutDate,
    today,
  });

  if (problem !== null) {
    throw new ValidationError(`terminations.errors.moveOutDate.${problem}`);
  }

  const reason = input.reason.trim();
  if (reason === '') {
    throw new ValidationError('terminations.errors.reasonRequired');
  }

  const assignment = await findOpenAssignment(residency.id, executor);

  return executor.transaction(async (tx) => {
    const updated = await updateResidency(
      actor.context,
      residency.id,
      {
        status: 'terminating',
        terminationRequestedAt: instant,
        moveOutDate: input.moveOutDate,
      },
      tx,
    );

    if (updated === null) {
      throw new ConflictError('terminations.errors.notUpdated');
    }

    /*
     * Место освобождается с даты выезда, а не сегодня: период занятости
     * полуоткрытый, поэтому новый жилец заезжает ровно в день выезда
     * прежнего — смена день в день штатна (§2.3 п.3).
     */
    if (assignment !== null) {
      await releaseBed(residency.id, input.moveOutDate, tx);

      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.bedReleased,
          entityType: 'residency',
          entityId: residency.id,
          before: { bedId: assignment.bedId },
          after: { releasedOn: input.moveOutDate },
        },
        tx,
      );
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.residencyTerminated,
        entityType: 'residency',
        entityId: residency.id,
        before: { status: residency.status },
        after: { status: 'terminating', moveOutDate: input.moveOutDate, reason },
      },
      tx,
    );

    return updated;
  });
}

/** Экран расчёта: остаток, ущерб, счётчик дней и решение по депозиту. */
export async function readTerminationView(
  actor: UserActor,
  residencyId: string,
  deps: TerminationDeps = {},
): Promise<TerminationView> {
  const { executor, today } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'deposit.read', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  const [{ balance, damages, transactions }, refundInvoice] = await Promise.all([
    depositState(actor, residency.id, executor),
    findRefundInvoice(actor, residency.id, executor),
  ]);

  const started = terminatedOn(residency);
  const fullMonths = fullMonthsOf(residency);

  const moveOutPassed =
    residency.moveOutDate !== null &&
    compareBusinessDates(parseBusinessDate(residency.moveOutDate), today) <= 0;

  return {
    residency,
    balance,
    damages,
    transactions,
    fullMonths,
    deadline: started === null ? null : refundDeadline(started),
    daysLeft: started === null ? null : daysUntilRefundDeadline(started, today),
    outcome: decideDepositOutcome({ fullMonths, balance }),
    refundInvoice,
    // Депозит разобран, когда возвращать больше нечего: остаток не положителен.
    canArchive: residency.status === 'terminating' && moveOutPassed && balance <= 0,
  };
}

/**
 * Счёт возврата (§2.2). Меньше трёх полных месяцев — счёт «Сожжён»
 * и остаток списывается сразу; иначе счёт «В ожидании» до фактической
 * выплаты. Возвращает `null`, когда возвращать нечего: нулевой остаток
 * или перерасход по ущербу (§2.4).
 */
export async function createRefundInvoice(
  actor: UserActor,
  residencyId: string,
  deps: TerminationDeps = {},
): Promise<Invoice | null> {
  const { executor, instant, today } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'invoice.issue', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  if (residency.status !== 'terminating') {
    throw new ConflictError('terminations.errors.notTerminating');
  }

  const existing = await findRefundInvoice(actor, residency.id, executor);
  if (existing !== null) {
    throw new ConflictError('terminations.errors.refundExists');
  }

  const { balance } = await depositState(actor, residency.id, executor);
  const fullMonths = fullMonthsOf(residency);
  const outcome = decideDepositOutcome({ fullMonths, balance });

  if (outcome.kind === 'nothing' || outcome.kind === 'debt') {
    return null;
  }

  const started = terminatedOn(residency);
  const burned = outcome.kind === 'burn';

  return executor.transaction(async (tx) => {
    const invoice = await createInvoice(
      actor.context,
      {
        houseId: residency.houseId,
        userId: residency.userId,
        residencyId: residency.id,
        type: 'deposit_refund',
        status: burned ? 'burned' : 'pending',
        total: outcome.amount,
        issuedAt: instant,
        dueDate: started === null ? today : refundDeadline(started),
        note: burned ? 'Депозит сгорел: менее трёх полных месяцев' : null,
        createdBy: actor.context.userId,
      },
      tx,
    );

    await addInvoiceLines(
      [
        {
          invoiceId: invoice.id,
          kind: 'deposit',
          title: burned ? 'Сгорание депозита' : 'Возврат депозита',
          amount: outcome.amount,
          meta: { fullMonths },
        },
      ],
      tx,
    );

    /*
     * Сгоревший депозит списывается сразу: он уходит в фонд дома, и остаток
     * жильца обязан обнулиться в тот же момент. Возврат списывается позже —
     * по факту выплаты, иначе остаток исчез бы до выдачи денег.
     */
    if (burned) {
      await createDepositTransaction(
        actor.context,
        {
          residencyId: residency.id,
          type: 'burn',
          amount: -outcome.amount,
          refType: 'invoice',
          refId: invoice.id,
          note: 'Сгорание депозита',
          createdBy: actor.context.userId,
        },
        tx,
      );
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: burned ? AUDIT_ACTIONS.depositBurned : AUDIT_ACTIONS.depositRefundIssued,
        entityType: 'invoice',
        entityId: invoice.id,
        after: { residencyId: residency.id, amount: outcome.amount, fullMonths },
      },
      tx,
    );

    return invoice;
  });
}

/** Фактическая выплата: «В ожидании» → «Возвращён» (§2.2). */
export async function settleRefund(
  actor: UserActor,
  invoiceId: string,
  deps: TerminationDeps = {},
): Promise<Invoice> {
  const { executor } = resolve(deps);

  const invoice = await requireInvoice(actor.context, invoiceId, executor);
  const residency = await requireResidency(actor.context, invoice.residencyId, executor);

  assertCan(actor.context, 'payment.record', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  if (invoice.type !== 'deposit_refund') {
    throw new ValidationError('terminations.errors.notRefundInvoice');
  }

  if (invoice.status !== 'pending') {
    throw new ConflictError('terminations.errors.refundClosed');
  }

  return executor.transaction(async (tx) => {
    const updated = await updateInvoice(actor.context, invoice.id, { status: 'returned' }, tx);
    if (updated === null) {
      throw new ConflictError('terminations.errors.notUpdated');
    }

    await createDepositTransaction(
      actor.context,
      {
        residencyId: residency.id,
        type: 'refund',
        amount: -invoice.total,
        refType: 'invoice',
        refId: invoice.id,
        note: 'Возврат депозита',
        createdBy: actor.context.userId,
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.depositRefunded,
        entityType: 'invoice',
        entityId: invoice.id,
        before: { status: invoice.status },
        after: { status: 'returned', amount: invoice.total },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Завершение выселения: `terminating` → `archived`
 * (docs/04-MODULES/01-onboarding.md, «Правила»).
 *
 * Отдельным действием, а не по расписанию: архивация закрывает жильцу
 * доступ окончательно, и решает это человек, разобравший депозит (P2-36).
 */
export async function archiveResidency(
  actor: UserActor,
  residencyId: string,
  deps: TerminationDeps = {},
): Promise<Residency> {
  const { executor, today } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'residency.terminate', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  if (residency.status !== 'terminating') {
    throw new ConflictError('terminations.errors.notTerminating');
  }

  if (
    residency.moveOutDate === null ||
    compareBusinessDates(parseBusinessDate(residency.moveOutDate), today) > 0
  ) {
    throw new ConflictError('terminations.errors.moveOutNotReached');
  }

  const { balance } = await depositState(actor, residency.id, executor);
  if (balance > 0) {
    throw new ConflictError('terminations.errors.depositNotSettled');
  }

  return executor.transaction(async (tx) => {
    const updated = await updateResidency(actor.context, residency.id, { status: 'archived' }, tx);
    if (updated === null) {
      throw new ConflictError('terminations.errors.notUpdated');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.residencyArchived,
        entityType: 'residency',
        entityId: residency.id,
        before: { status: residency.status, balance },
        after: { status: 'archived' },
      },
      tx,
    );

    return updated;
  });
}
