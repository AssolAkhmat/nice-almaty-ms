import { getDb, type Executor } from '@/db/client';
import { requireBed } from '@/db/repositories/areas';
import { countDamageSharesOfUser } from '@/db/repositories/damages';
import { countChargeInvoices } from '@/db/repositories/invoices';
import { listInvoices } from '@/db/repositories/invoices';
import {
  assignBed,
  findOpenAssignment,
  requireResidency,
  saveMonthRent,
} from '@/db/repositories/residencies';
import { releaseTemporaryOnBed } from '@/db/repositories/temporary-residents';
import { countAllocationsOfUser } from '@/db/repositories/utilities';
import { periodLiteral } from '@/db/period';
import { bedAssignments, temporaryPlacements } from '@/db/schema';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import {
  addMonths,
  compareBusinessDates,
  startOfMonth,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { editInvoiceLines, readInvoice } from './invoices';
import { syncFutureAssignments } from './rotation-schedule';

import type { BedAssignment, Residency, ResidencyMonthRent, TemporaryPlacement } from '@/db/schema';
import type { UserActor } from './users';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Переселение внутри дома (указание владельца, 27 сентября 2026, P1-5).
 *
 * Главное правило: существующая запись назначения места **никогда
 * не обновляется**. Переселение — закрытие текущего назначения датой
 * и создание нового. История «кто где жил в какую дату» несущая: на ней
 * стоят человеко-дни коммуналки, график ротаций и пункт 2.2.3 Договора —
 * ущерб делится между теми, кто жил в комнате на дату фиксации повреждения.
 * Перезапись места задним числом порвала бы привязку прошлого ущерба.
 *
 * Три сценария, и путать их нельзя:
 *
 * 1. `correctAssignment` — исправление ошибки ввода. Ошибочное назначение
 *    аннулируется целиком, новое встаёт той же датой начала. Доступно, пока
 *    по проживанию нет ни одного проведённого начисления.
 * 2. `placeTemporarily` — временное размещение. Расчётное место остаётся
 *    за жильцом: цена, коммуналка, ротации и акты не меняются.
 * 3. `moveBedPermanently` — постоянное переселение. Назначение закрывается,
 *    открывается новое; при смене цены нужна отметка о согласии жильца
 *    (п. 6.2 Договора о существенных условиях).
 */
export interface BedMoveDeps {
  executor?: Executor;
  today?: BusinessDate;
}

export interface CorrectAssignmentInput {
  residencyId: string;
  /** Правильное место — в том же доме. */
  bedId: string;
  price?: number | undefined;
  /** Что именно было введено неверно: остаётся в журнале. */
  reason: string;
}

export interface TemporaryPlacementInput {
  residencyId: string;
  bedId: string;
  from?: BusinessDate | undefined;
  /** Пусто — размещение без конца, до отдельного решения. */
  to?: BusinessDate | undefined;
  reason: string;
}

export interface PermanentMoveInput {
  residencyId: string;
  bedId: string;
  price?: number | undefined;
  from?: BusinessDate | undefined;
  reason: string;
  /**
   * Отметка о согласии жильца с новой ценой и дата согласия. Обязательна,
   * когда цена меняется: это существенное условие договора (п. 6.2).
   */
  consent?: { agreedOn: BusinessDate } | undefined;
  /**
   * Ручной перерасчёт платы за месяц переселения (D37, решение владельца
   * от 30 сентября 2026). Обязателен, когда цена меняется: система эту сумму
   * не вычисляет — пропорция по дням противоречила бы п. 4.1 Договора,
   * где минимальная единица расчёта — календарный месяц.
   */
  monthRent?: { amount: number; comment: string } | undefined;
}

export interface BedMovePreview {
  /** Цена сейчас и цена после переселения. */
  currentPrice: number | null;
  nextPrice: number;
  /**
   * С какого месяца новая цена попадёт в счёт. Смена цены внутри месяца
   * текущий счёт не меняет: он выставлен первого числа по цене на первое
   * число (§3, `rentForMonth`). Поэтому новая цена начинает действовать
   * с первого числа следующего месяца — консервативный вариант из п. 4.1
   * Договора, где минимальная единица расчёта — календарный месяц.
   */
  priceAppliesFrom: BusinessDate;
  priceChanges: boolean;
  /** Нужна ли отметка о согласии жильца (п. 6.2). */
  consentRequired: boolean;
  /** Есть ли проведённые начисления: от этого зависит, можно ли исправлять. */
  hasPostedCharges: boolean;
}

async function hasPostedCharges(residency: Residency, executor: Executor): Promise<boolean> {
  const [invoices, damages, allocations] = await Promise.all([
    countChargeInvoices(residency.id, executor),
    countDamageSharesOfUser(residency.userId, executor),
    countAllocationsOfUser(residency.userId, executor),
  ]);

  return invoices > 0 || damages > 0 || allocations > 0;
}

async function bedInSameHouse(
  actor: UserActor,
  residency: Residency,
  bedId: string,
  executor: Executor,
) {
  const bed = await requireBed(actor.context, bedId, executor);

  if (bed.houseId !== residency.houseId) {
    /*
     * Место другого дома — это переселение между домами (D26), другое
     * действие с другими последствиями: меняется дом проживания, правила
     * рейтинга и группы допуска. Путать их нельзя.
     */
    throw new ValidationError('bedMoves.errors.otherHouse');
  }

  return bed;
}

function assertReason(reason: string): string {
  const trimmed = reason.trim();

  if (trimmed === '') {
    throw new ValidationError('bedMoves.errors.reasonRequired');
  }

  return trimmed;
}

function assertMovable(actor: UserActor, residency: Residency): void {
  assertCan(actor.context, 'bed.assign', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  if (residency.status === 'archived') {
    throw new ConflictError('bedMoves.errors.archived');
  }
}

export interface BedMoveContext {
  /** Цена действующего назначения; пусто — места нет. */
  currentPrice: number | null;
  /** С какого числа новая цена попадёт в счёт (п. 4.1 Договора). */
  priceAppliesFrom: BusinessDate;
  /**
   * Есть ли проведённые начисления. Пока нет — ошибку ввода можно исправить
   * аннулированием; как только есть — только переселение с историей.
   */
  hasPostedCharges: boolean;
}

/**
 * Последствия переселения до выбора места: цена сейчас, месяц вступления новой
 * и есть ли начисления. Показывается на экране до сохранения — владелец просил
 * предпросмотр, а не «сохрани и посмотри, что вышло».
 */
export async function readBedMoveContext(
  actor: UserActor,
  residencyId: string,
  deps: BedMoveDeps = {},
): Promise<BedMoveContext> {
  const executor = deps.executor ?? getDb();
  const today = deps.today ?? todayInAlmaty();

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertMovable(actor, residency);

  const open = await findOpenAssignment(residency.id, executor);

  return {
    currentPrice: open?.price ?? null,
    priceAppliesFrom: addMonths(startOfMonth(today), 1),
    hasPostedCharges: await hasPostedCharges(residency, executor),
  };
}

/** Что произойдёт при переселении: показывается до сохранения. */
export async function previewBedMove(
  actor: UserActor,
  input: { residencyId: string; bedId: string; price?: number | undefined },
  deps: BedMoveDeps = {},
): Promise<BedMovePreview> {
  const executor = deps.executor ?? getDb();
  const today = deps.today ?? todayInAlmaty();

  const residency = await requireResidency(actor.context, input.residencyId, executor);
  assertMovable(actor, residency);

  const bed = await bedInSameHouse(actor, residency, input.bedId, executor);
  const open = await findOpenAssignment(residency.id, executor);
  const nextPrice = input.price ?? bed.defaultPrice;
  const currentPrice = open?.price ?? null;
  const priceChanges = currentPrice !== null && currentPrice !== nextPrice;

  return {
    currentPrice,
    nextPrice,
    priceAppliesFrom: addMonths(startOfMonth(today), 1),
    priceChanges,
    consentRequired: priceChanges,
    hasPostedCharges: await hasPostedCharges(residency, executor),
  };
}

/**
 * Исправление ошибки ввода места.
 *
 * Ошибочное назначение удаляется целиком, а не закрывается датой: жилец
 * в этом месте не жил ни дня, и закрытый отрезок означал бы, что жил.
 * Содержимое удалённой строки уходит в журнал снимком — след остаётся там,
 * где его и ищут.
 *
 * Доступно, пока по проживанию нет ни одного проведённого начисления:
 * счёта, доли коммуналки или доли ущерба. Как только начисление есть,
 * прошлое место несёт смысл, и путь только один — постоянное переселение.
 */
export async function correctAssignment(
  actor: UserActor,
  input: CorrectAssignmentInput,
  deps: BedMoveDeps = {},
): Promise<BedAssignment> {
  const executor = deps.executor ?? getDb();

  const residency = await requireResidency(actor.context, input.residencyId, executor);
  assertMovable(actor, residency);

  const reason = assertReason(input.reason);
  const bed = await bedInSameHouse(actor, residency, input.bedId, executor);
  const open = await findOpenAssignment(residency.id, executor);

  if (open === null) {
    throw new NotFoundError('Место жильцу не назначено: исправлять нечего');
  }

  if (await hasPostedCharges(residency, executor)) {
    throw new ConflictError('bedMoves.errors.chargesPosted');
  }

  const price = input.price ?? bed.defaultPrice;

  if (!Number.isInteger(price) || price < 0) {
    throw new ValidationError('beds.priceInvalid');
  }

  /* Новое назначение встаёт той же датой начала: ошибка ввода, а не переезд. */
  const from = sql<string>`lower(${bedAssignments.period})`;
  const [row] = await executor
    .select({ from })
    .from(bedAssignments)
    .where(eq(bedAssignments.id, open.id));

  const start = (row?.from ?? '') as BusinessDate;

  return executor.transaction(async (tx) => {
    await tx.delete(bedAssignments).where(eq(bedAssignments.id, open.id));

    const releasedTemporaries = await releaseTemporaryOnBed(actor.context, bed.id, start, tx);

    for (const temporary of releasedTemporaries) {
      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.temporaryResidentReleased,
          entityType: 'temporary_resident',
          entityId: temporary.id,
          before: { name: temporary.name, period: temporary.period },
          after: { releasedFrom: start, residencyId: residency.id },
        },
        tx,
      );
    }

    const assignment = await assignBed(
      {
        residencyId: residency.id,
        bedId: bed.id,
        price,
        from: start,
        createdBy: actor.context.userId,
      },
      tx,
    );

    await syncFutureAssignments(actor, residency.houseId, start, { executor: tx, today: start });

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.bedAssignmentCorrected,
        entityType: 'residency',
        entityId: residency.id,
        before: { bedId: open.bedId, price: open.price, period: open.period },
        after: { bedId: bed.id, price, from: start, reason },
      },
      tx,
    );

    return assignment;
  });
}

/**
 * Временное размещение: где человек живёт физически, пока расчётное место
 * остаётся за ним. Ни цена, ни коммуналка, ни ротации, ни акты не меняются —
 * `bed_assignments` эта операция не трогает вовсе.
 */
export async function placeTemporarily(
  actor: UserActor,
  input: TemporaryPlacementInput,
  deps: BedMoveDeps = {},
): Promise<TemporaryPlacement> {
  const executor = deps.executor ?? getDb();
  const today = deps.today ?? todayInAlmaty();

  const residency = await requireResidency(actor.context, input.residencyId, executor);
  assertMovable(actor, residency);

  const reason = assertReason(input.reason);
  const bed = await bedInSameHouse(actor, residency, input.bedId, executor);
  const from = input.from ?? today;

  if (input.to !== undefined && compareBusinessDates(input.to, from) <= 0) {
    throw new ValidationError('bedMoves.errors.emptyPeriod');
  }

  return executor.transaction(async (tx) => {
    const [placement] = await tx
      .insert(temporaryPlacements)
      .values({
        orgId: actor.context.orgId,
        residencyId: residency.id,
        houseId: residency.houseId,
        bedId: bed.id,
        period: periodLiteral({ from, to: input.to ?? null }),
        reason,
        createdBy: actor.context.userId,
      })
      .returning();

    if (placement === undefined) {
      throw new Error('Временное размещение не сохранено');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.temporaryPlacementCreated,
        entityType: 'residency',
        entityId: residency.id,
        after: { bedId: bed.id, from, to: input.to ?? null, reason },
      },
      tx,
    );

    return placement;
  });
}

/** Временные размещения жильца, свежие сверху. */
export async function listTemporaryPlacements(
  actor: UserActor,
  residencyId: string,
  deps: BedMoveDeps = {},
): Promise<TemporaryPlacement[]> {
  const executor = deps.executor ?? getDb();

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'bed.read', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  return executor
    .select()
    .from(temporaryPlacements)
    .where(
      and(
        eq(temporaryPlacements.orgId, actor.context.orgId),
        eq(temporaryPlacements.residencyId, residencyId),
      ),
    )
    .orderBy(sql`lower(${temporaryPlacements.period}) desc`, temporaryPlacements.id);
}

/**
 * Постоянное переселение внутри дома.
 *
 * Цена: с первого числа следующего месяца в счёт идёт новая — это следствие
 * правила §3, а не отдельная механика: счёт выставляется первого числа по цене
 * назначения, действующего на первое число.
 *
 * Месяц самого переезда пересчитывается **вручную** (D37, решение владельца
 * от 30 сентября 2026). Автоматической пропорции по дням здесь нет и не будет:
 * п. 4.1 Договора говорит, что минимальная единица расчёта — календарный месяц,
 * и зашитая формула ему противоречила бы. Администратор вводит сумму сам,
 * с обязательным комментарием; расчётное значение по старой цене сохраняется
 * снимком рядом — тем же способом, что человеко-дни в P2-6. Отметка о согласии
 * жильца (п. 6.2) хранится вместе с суммой, а не только в журнале.
 *
 * Введённая сумма не остаётся данными ради данных: счёт месяца, если он ещё
 * не оплачен, правится на неё тут же. Оплаченный счёт не переписывается
 * (§3), и тогда ответ это называет — молча расходиться счёт и перерасчёт
 * не должны.
 *
 * Пункт 8.10 Договора требует нового Акта приёма-передачи имущества.
 * Сущности акта в системе нет — он бумажный, и система о нём только
 * напоминает записью в журнале (строка `[ОТКРЫТО]`).
 */
export async function moveBedPermanently(
  actor: UserActor,
  input: PermanentMoveInput,
  deps: BedMoveDeps = {},
): Promise<{
  assignment: BedAssignment;
  priceAppliesFrom: BusinessDate;
  /** Запись ручного перерасчёта; пусто — цена не менялась (D37). */
  monthRent: ResidencyMonthRent | null;
  /** Что стало со счётом месяца. */
  invoice: MonthInvoiceOutcome;
}> {
  const executor = deps.executor ?? getDb();
  const today = deps.today ?? todayInAlmaty();

  const residency = await requireResidency(actor.context, input.residencyId, executor);
  assertMovable(actor, residency);

  const reason = assertReason(input.reason);
  const bed = await bedInSameHouse(actor, residency, input.bedId, executor);
  const open = await findOpenAssignment(residency.id, executor);
  const price = input.price ?? bed.defaultPrice;

  if (!Number.isInteger(price) || price < 0) {
    throw new ValidationError('beds.priceInvalid');
  }

  const from = input.from ?? today;

  if (
    residency.moveInDate !== null &&
    compareBusinessDates(from, residency.moveInDate as BusinessDate) < 0
  ) {
    throw new ValidationError('bedMoves.errors.beforeMoveIn');
  }

  const priceChanges = open !== null && open.price !== price;

  if (priceChanges && input.consent === undefined) {
    /*
     * Цена — существенное условие (п. 6.2 Договора): без отметки о согласии
     * жильца действие не проходит. Проверка здесь, а не только в форме:
     * форма — не единственная дорога.
     */
    throw new ValidationError('bedMoves.errors.consentRequired');
  }

  /*
   * Сумма за месяц переезда: вводится вручную и только при смене цены (D37).
   * Без неё месяц остался бы по старой цене молча, а это уже не решение
   * администратора, а поведение по умолчанию, которого никто не выбирал.
   */
  if (priceChanges && input.monthRent === undefined) {
    throw new ValidationError('bedMoves.errors.monthRentRequired');
  }

  if (input.monthRent !== undefined) {
    if (!Number.isSafeInteger(input.monthRent.amount) || input.monthRent.amount < 0) {
      throw new ValidationError('bedMoves.errors.monthRentInvalid');
    }

    if (input.monthRent.comment.trim() === '') {
      throw new ValidationError('bedMoves.errors.monthRentComment');
    }
  }

  const priceAppliesFrom = addMonths(startOfMonth(from), 1);
  const month = startOfMonth(from);

  return executor.transaction(async (tx) => {
    const releasedTemporaries = await releaseTemporaryOnBed(actor.context, bed.id, from, tx);

    for (const temporary of releasedTemporaries) {
      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.temporaryResidentReleased,
          entityType: 'temporary_resident',
          entityId: temporary.id,
          before: { name: temporary.name, period: temporary.period },
          after: { releasedFrom: from, residencyId: residency.id },
        },
        tx,
      );
    }

    /*
     * `assignBed` сам закрывает открытое назначение этой же датой и создаёт
     * новое — ровно «закрыть и открыть», без обновления прошлой строки.
     */
    const assignment = await assignBed(
      { residencyId: residency.id, bedId: bed.id, price, from, createdBy: actor.context.userId },
      tx,
    );

    await syncFutureAssignments(actor, residency.houseId, from, { executor: tx, today: from });

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.bedMovedPermanently,
        entityType: 'residency',
        entityId: residency.id,
        before: { bedId: open?.bedId ?? null, price: open?.price ?? null },
        after: {
          bedId: bed.id,
          price,
          from,
          reason,
          priceAppliesFrom,
          consentAgreedOn: input.consent?.agreedOn ?? null,
          /* Напоминание о бумаге: акта как сущности в системе нет (п. 8.10). */
          handoverActRequired: true,
        },
      },
      tx,
    );

    let monthRent: ResidencyMonthRent | null = null;
    let invoice: MonthInvoiceOutcome = 'not-applicable';

    if (input.monthRent !== undefined && input.consent !== undefined) {
      monthRent = await saveMonthRent(
        {
          residencyId: residency.id,
          month,
          amount: input.monthRent.amount,
          /* Снимок: что дала бы старая цена за полный месяц (п. 4.1). */
          computedAmount: open?.price ?? 0,
          comment: input.monthRent.comment.trim(),
          consentAgreedOn: input.consent.agreedOn,
          createdBy: actor.context.userId,
        },
        tx,
      );

      invoice = await applyMonthRent(actor, residency.id, month, input.monthRent.amount, tx);

      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.monthRentRecalculated,
          entityType: 'residency_month_rent',
          entityId: monthRent.id,
          before: { amount: monthRent.computedAmount, computedAmount: monthRent.computedAmount },
          after: {
            amount: monthRent.amount,
            month,
            comment: monthRent.comment,
            consentAgreedOn: monthRent.consentAgreedOn,
            invoice,
          },
        },
        tx,
      );
    }

    return { assignment, priceAppliesFrom, monthRent, invoice };
  });
}

/** Что стало со счётом месяца после ручного перерасчёта (D37). */
export type MonthInvoiceOutcome =
  'updated' | 'no-invoice' | 'closed' | 'no-rent-line' | 'not-applicable';

/**
 * Перенести пересчитанную сумму в счёт месяца.
 *
 * Правится строка проживания, остальные строки счёта не трогаются: коммуналка
 * и ручные начисления к цене места отношения не имеют. Оплаченный счёт
 * не переписывается — §3 это прямо запрещает, — и тогда ответ называет причину,
 * а не делает вид, что перерасчёт применён.
 */
async function applyMonthRent(
  actor: UserActor,
  residencyId: string,
  month: BusinessDate,
  amount: number,
  tx: Executor,
): Promise<MonthInvoiceOutcome> {
  const invoices = await listInvoices(
    actor.context,
    { residencyId, type: 'monthly', periodMonth: month },
    tx,
  );

  const target = invoices.find((candidate) => candidate.status !== 'cancelled');

  if (target === undefined) {
    /* Счёт месяца ещё не выставлен: генерация первого числа возьмёт сумму сама. */
    return 'no-invoice';
  }

  if (target.status === 'paid') {
    return 'closed';
  }

  const view = await readInvoice(actor, target.id, { executor: tx });
  const rent = view.lines.find((line) => line.kind === 'rent');

  if (rent === undefined) {
    return 'no-rent-line';
  }

  await editInvoiceLines(
    actor,
    target.id,
    view.lines.map((line) => ({
      kind: line.kind,
      title: line.title,
      amount: line.id === rent.id ? amount : line.amount,
    })),
    { executor: tx },
  );

  return 'updated';
}

/** Закрыть временное размещение датой: человек вернулся на своё место. */
export async function endTemporaryPlacement(
  actor: UserActor,
  placementId: string,
  on: BusinessDate,
  deps: BedMoveDeps = {},
): Promise<void> {
  const executor = deps.executor ?? getDb();

  const [placement] = await executor
    .select()
    .from(temporaryPlacements)
    .where(
      and(
        eq(temporaryPlacements.id, placementId),
        eq(temporaryPlacements.orgId, actor.context.orgId),
      ),
    );

  if (placement === undefined) {
    throw new NotFoundError('Временное размещение не найдено');
  }

  const residency = await requireResidency(actor.context, placement.residencyId, executor);
  assertMovable(actor, residency);

  await executor.transaction(async (tx) => {
    await tx
      .update(temporaryPlacements)
      .set({ period: sql`daterange(lower(${temporaryPlacements.period}), ${on}, '[)')` })
      .where(eq(temporaryPlacements.id, placementId));

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.temporaryPlacementEnded,
        entityType: 'residency',
        entityId: residency.id,
        before: { placementId, period: placement.period },
        after: { endedOn: on },
      },
      tx,
    );
  });
}
