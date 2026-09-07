import { getDb, type Executor } from '@/db/client';
import { listInvoices } from '@/db/repositories/invoices';
import { listResidencies } from '@/db/repositories/residencies';
import {
  addUtilityLine,
  createUtilityPeriod,
  deleteUtilityLine,
  findUtilityLine,
  findUtilityPeriod,
  listUtilityAllocations,
  listUtilityLines,
  listUtilityHistory,
  listUtilityPeriods,
  requireUtilityPeriod,
  saveUtilityAllocations,
  updateUtilityLine,
  updateUtilityPeriod,
} from '@/db/repositories/utilities';
import {
  daysLivedInMonth,
  distributeUtilities,
  monthOf,
  type UtilityDistribution,
} from '@/domain/utilities';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { addMonths, now, startOfMonth, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { appendInvoiceLine, createInvoice } from './invoices';
import { postUtilitySurplus } from './ledger';

import type { UtilityAllocation, UtilityLine, UtilityPeriod, Residency } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Коммунальный период (docs/03-BUSINESS-RULES.md §4,
 * docs/04-MODULES/06-utilities.md).
 *
 * Арифметика долей — чистые функции `src/domain/utilities.ts`. Здесь то,
 * что делает закрытие периода: снимок распределения, доли в счетах и перевод
 * излишка округления в фонд дома. Пока период открыт, распределение
 * предварительное и никуда не записывается — иначе правка строки меняла бы
 * уже выставленные счета задним числом.
 *
 * Долгосрочные отсутствия (§4.2) появятся в фазе 5: пока их источника нет,
 * вычитаемых дней ноль, и это видно по коду, а не по умолчанию.
 */
export interface UtilityDeps {
  executor?: Executor;
  today?: BusinessDate;
  instant?: Date;
}

function resolve(deps: UtilityDeps): { executor: Executor; today: BusinessDate; instant: Date } {
  const instant = deps.instant ?? now();

  return {
    executor: deps.executor ?? getDb(),
    today: deps.today ?? todayInAlmaty(instant),
    instant,
  };
}

export interface UtilityLineInput {
  title: string;
  amount: number;
  receiptFileId?: string | null | undefined;
}

export interface UtilityPeriodView {
  period: UtilityPeriod;
  lines: UtilityLine[];
  total: number;
  /** Предварительное распределение: пересчитывается на каждый просмотр. */
  preview: UtilityDistribution;
  /** Снимок закрытого периода; у открытого — пусто. */
  allocations: UtilityAllocation[];
}

export interface ClosedPeriod {
  period: UtilityPeriod;
  allocations: UtilityAllocation[];
  /** В скольких счетах доля оказалась строкой. */
  invoiced: number;
}

function totalOf(lines: readonly { amount: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amount, 0);
}

function assertAmount(amount: number): void {
  // Деньги — целые тенге (§0). Отрицательная коммуналка — не скидка, а ошибка.
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new ValidationError('utilities.errors.amountInvalid');
  }
}

/**
 * Кто делит коммуналку месяца: все, кто прожил в доме хотя бы день (§4.2).
 * Съехавшие входят наравне — они жили в этом месяце; админ дома тоже,
 * он платит коммуналку.
 */
async function participantsOf(
  actor: UserActor,
  houseId: string,
  month: BusinessDate,
  executor: Executor,
): Promise<{ userId: string; residency: Residency; days: number }[]> {
  const residencies = await listResidencies(actor.context, { houseId }, executor);

  return residencies
    .map((residency) => ({
      userId: residency.userId,
      residency,
      days: daysLivedInMonth({
        month,
        moveIn: residency.moveInDate === null ? null : (residency.moveInDate as BusinessDate),
        moveOut: residency.moveOutDate === null ? null : (residency.moveOutDate as BusinessDate),
      }),
    }))
    .filter((entry) => entry.days > 0);
}

/** Период дома за месяц; заводится пустым, если его ещё нет (модуль 6). */
export async function openUtilityPeriod(
  actor: UserActor,
  houseId: string,
  month: BusinessDate,
  deps: UtilityDeps = {},
): Promise<UtilityPeriod> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'utility.manage', { houseId });

  const first = startOfMonth(month);
  const existing = await findUtilityPeriod(actor.context, houseId, first, executor);

  if (existing !== null) {
    return existing;
  }

  return createUtilityPeriod(actor.context, { houseId, month: first, status: 'draft' }, executor);
}

/** Период вместе с правом на него: права на период — это права на его дом. */
async function periodFor(
  actor: UserActor,
  periodId: string,
  action: 'utility.read' | 'utility.manage' | 'utility.reopen',
  executor: Executor,
): Promise<UtilityPeriod> {
  const period = await requireUtilityPeriod(actor.context, periodId, executor);

  assertCan(actor.context, action, { houseId: period.houseId });

  return period;
}

export async function readUtilityPeriod(
  actor: UserActor,
  periodId: string,
  deps: UtilityDeps = {},
): Promise<UtilityPeriodView> {
  const { executor } = resolve(deps);

  const period = await periodFor(actor, periodId, 'utility.read', executor);
  const month = period.month as BusinessDate;

  const [lines, allocations, participants] = await Promise.all([
    listUtilityLines(period.id, executor),
    listUtilityAllocations(period.id, executor),
    participantsOf(actor, period.houseId, month, executor),
  ]);

  const total = totalOf(lines);

  return {
    period,
    lines,
    total,
    preview: distributeUtilities(
      total,
      participants.map((entry) => ({ userId: entry.userId, days: entry.days })),
    ),
    allocations,
  };
}

function assertDraft(period: UtilityPeriod): void {
  if (period.status !== 'draft') {
    throw new ConflictError('utilities.errors.closed');
  }
}

export async function addPeriodLine(
  actor: UserActor,
  periodId: string,
  input: UtilityLineInput,
  deps: UtilityDeps = {},
): Promise<UtilityLine> {
  const { executor } = resolve(deps);

  const period = await periodFor(actor, periodId, 'utility.manage', executor);
  assertDraft(period);
  assertAmount(input.amount);

  if (input.title.trim() === '') {
    throw new ValidationError('utilities.errors.titleRequired');
  }

  return addUtilityLine(
    {
      periodId: period.id,
      title: input.title.trim(),
      amount: input.amount,
      receiptFileId: input.receiptFileId ?? null,
    },
    executor,
  );
}

/** Строка правится вместе с периодом: закрытый период строк не отдаёт. */
async function lineWithPeriod(
  actor: UserActor,
  lineId: string,
  executor: Executor,
): Promise<{ line: UtilityLine; period: UtilityPeriod }> {
  const line = await findUtilityLine(lineId, executor);

  if (line === null) {
    throw new NotFoundError('Строка коммуналки не найдена');
  }

  const period = await periodFor(actor, line.periodId, 'utility.manage', executor);

  return { line, period };
}

export async function updatePeriodLine(
  actor: UserActor,
  lineId: string,
  input: UtilityLineInput,
  deps: UtilityDeps = {},
): Promise<UtilityLine> {
  const { executor } = resolve(deps);

  const { period } = await lineWithPeriod(actor, lineId, executor);
  assertDraft(period);
  assertAmount(input.amount);

  const updated = await updateUtilityLine(
    lineId,
    { title: input.title.trim(), amount: input.amount },
    executor,
  );

  if (updated === null) {
    throw new NotFoundError('Строка коммуналки не найдена');
  }

  return updated;
}

export async function removePeriodLine(
  actor: UserActor,
  lineId: string,
  deps: UtilityDeps = {},
): Promise<void> {
  const { executor } = resolve(deps);

  const { period } = await lineWithPeriod(actor, lineId, executor);
  assertDraft(period);

  await deleteUtilityLine(lineId, executor);
}

/**
 * Закрытие периода (§4, модуль 6). Снимок распределения фиксируется, доли
 * уходят в счета того же месяца, что и следующий за периодом, а излишек
 * округления переводится в фонд дома.
 *
 * Счёт за следующий месяц может быть ещё не выставлен — тогда доля дождётся
 * генерации 1 числа: она читает тот же снимок. Уже оплаченный счёт правке
 * не подлежит, и доля уходит отдельным счётом: деньги не должны потеряться
 * оттого, что жилец заплатил раньше, чем админ закрыл период.
 */
export async function closeUtilityPeriod(
  actor: UserActor,
  periodId: string,
  deps: UtilityDeps = {},
): Promise<ClosedPeriod> {
  const { executor, today, instant } = resolve(deps);

  const period = await periodFor(actor, periodId, 'utility.manage', executor);
  assertDraft(period);

  const month = period.month as BusinessDate;
  const lines = await listUtilityLines(period.id, executor);
  const total = totalOf(lines);

  if (total <= 0) {
    throw new ConflictError('utilities.errors.nothingToDistribute');
  }

  const participants = await participantsOf(actor, period.houseId, month, executor);
  const distribution = distributeUtilities(
    total,
    participants.map((entry) => ({ userId: entry.userId, days: entry.days })),
  );

  if (distribution.allocations.length === 0) {
    throw new ConflictError('utilities.errors.noParticipants');
  }

  const byUser = new Map(participants.map((entry) => [entry.userId, entry.residency]));
  const invoiceMonth = addMonths(month, 1);

  return executor.transaction(async (tx) => {
    const allocations = await saveUtilityAllocations(
      period.id,
      distribution.allocations.map((allocation) => ({
        userId: allocation.userId,
        days: allocation.days,
        amount: allocation.amount,
      })),
      tx,
    );

    const closed = await updateUtilityPeriod(
      actor.context,
      period.id,
      { status: 'closed', closedAt: instant, closedBy: actor.context.userId },
      tx,
    );

    if (closed === null) {
      throw new ConflictError('utilities.errors.notUpdated');
    }

    /*
     * Излишек округления — в фонд дома (§4.2). Проводка идёт при закрытии,
     * а не при оплате: жильцы вносят сумму долей, коммунальный фонд должен
     * поставщику ровно итог периода, и разница дому причитается уже сейчас.
     */
    if (distribution.surplus > 0) {
      await postUtilitySurplus(
        actor,
        { houseId: period.houseId, sourceId: period.id, amount: distribution.surplus, date: today },
        { executor: tx, today },
      );
    }

    let invoiced = 0;

    for (const allocation of distribution.allocations) {
      const residency = byUser.get(allocation.userId);

      if (residency === undefined) {
        continue;
      }

      const line = {
        kind: 'utilities' as const,
        title: `Коммунальные услуги за ${month.slice(0, 7)}`,
        amount: allocation.amount,
      };

      const existing = await listInvoices(
        actor.context,
        { residencyId: residency.id, type: 'monthly', periodMonth: invoiceMonth },
        tx,
      );

      const target = existing.find(
        (invoice) => invoice.status !== 'cancelled' && invoice.status !== 'paid',
      );

      if (target !== undefined) {
        await appendInvoiceLine(actor, target.id, line, { executor: tx, today });
        invoiced += 1;
        continue;
      }

      // Счёт месяца закрыт полностью — доля уходит отдельным счётом.
      if (existing.some((invoice) => invoice.status === 'paid')) {
        await createInvoice(
          actor,
          {
            residencyId: residency.id,
            type: 'extra',
            periodMonth: invoiceMonth,
            note: 'Коммунальные услуги: период закрыт после оплаты счёта',
            lines: [line],
          },
          { executor: tx, today },
        );
        invoiced += 1;
      }
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.utilityPeriodClosed,
        entityType: 'utility_period',
        entityId: period.id,
        after: {
          month,
          total,
          participants: distribution.allocations.length,
          surplus: distribution.surplus,
          invoiced,
        },
      },
      tx,
    );

    return { period: closed, allocations, invoiced };
  });
}

/**
 * Переоткрытие — только суперадмин и с записью в журнал (§4, модуль 6).
 * Снимок стирается: он относился к прежним строкам. Строки, уже попавшие
 * в счета, отсюда не убираются — счёт правится своим экраном, и это
 * осознанная ручная работа ([ОТКРЫТО] P3-24).
 */
export async function reopenUtilityPeriod(
  actor: UserActor,
  periodId: string,
  deps: UtilityDeps = {},
): Promise<UtilityPeriod> {
  const { executor } = resolve(deps);

  const period = await periodFor(actor, periodId, 'utility.reopen', executor);

  if (period.status !== 'closed') {
    throw new ConflictError('utilities.errors.notClosed');
  }

  return executor.transaction(async (tx) => {
    await saveUtilityAllocations(period.id, [], tx);

    const reopened = await updateUtilityPeriod(
      actor.context,
      period.id,
      { status: 'draft', closedAt: null, closedBy: null },
      tx,
    );

    if (reopened === null) {
      throw new ConflictError('utilities.errors.notUpdated');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.utilityPeriodReopened,
        entityType: 'utility_period',
        entityId: period.id,
        before: { status: 'closed' },
        after: { status: 'draft', month: period.month },
      },
      tx,
    );

    return reopened;
  });
}

export interface UtilityHistoryEntry {
  periodId: string;
  month: string;
  /** Сумма долей: ущерб периода вместе с излишком округления. */
  total: number;
  participants: number;
  days: number;
  /** Средняя доля на жильца, целые тенге вниз: это справка, а не начисление. */
  averageShare: number;
}

/**
 * История коммуналки по дому (модуль 6, «Отчёты»): месяц, сумма, средняя
 * доля, число жильцов и дней. Сравнение домов идёт переключателем дома —
 * тем же, что на остальных экранах сети.
 */
export async function readUtilityHistory(
  actor: UserActor,
  houseId: string,
  deps: UtilityDeps = {},
): Promise<UtilityHistoryEntry[]> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'utility.read', { houseId });

  const rows = await listUtilityHistory(actor.context, houseId, executor);

  return rows.map((row) => ({
    periodId: row.periodId,
    month: row.month,
    total: row.total,
    participants: row.participants,
    days: row.days,
    averageShare: row.participants === 0 ? 0 : Math.floor(row.total / row.participants),
  }));
}

/** Периоды дома по месяцам — список для экрана коммуналки. */
export async function listPeriodsOfHouse(
  actor: UserActor,
  houseId: string,
  deps: UtilityDeps = {},
): Promise<UtilityPeriod[]> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'utility.read', { houseId });

  return listUtilityPeriods(actor.context, { houseId }, executor);
}

/** Первое число месяца, к которому относится дата: для экрана периода. */
export { monthOf };
