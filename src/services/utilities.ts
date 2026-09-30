import { getDb, type Executor } from '@/db/client';
import { listLedgerEntriesBySource } from '@/db/repositories/accounts';
import { listInvoices } from '@/db/repositories/invoices';
import { listApprovedAbsences } from '@/db/repositories/rating';
import { listMonthStaysInHouse } from '@/db/repositories/residencies';
import {
  addUtilityLine,
  listClosedReceipts,
  createUtilityPeriod,
  deleteUtilityLine,
  findUtilityLine,
  findResidentShare,
  findUtilityPeriod,
  listDayAdjustments,
  listUtilityAllocations,
  listUtilityLines,
  listUtilityHistory,
  listUtilityPeriods,
  requireUtilityPeriod,
  saveDayAdjustment,
  saveUtilityAllocations,
  updateUtilityLine,
  updateUtilityPeriod,
} from '@/db/repositories/utilities';
import {
  checkDayCorrection,
  distributeUtilities,
  occupiedDaysInMonth,
  monthOf,
  type UtilityDistribution,
} from '@/domain/utilities';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import {
  addMonths,
  endOfMonth,
  now,
  startOfMonth,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit, withAudit } from './audit';
import { appendInvoiceLine, createInvoice } from './invoices';
import { postUtilityHouseShare, postUtilitySurplus, reverseEntry } from './ledger';

import type { ResidentUtilityShare } from '@/db/repositories/utilities';
import type {
  UtilityAllocation,
  UtilityDayAdjustment,
  UtilityLine,
  UtilityPeriod,
} from '@/db/schema';
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

/** Участник распределения: расчётные сутки, итоговые и правка, если была. */
export interface UtilityParticipantRow {
  userId: string;
  residencyId: string;
  /** Что посчитала формула §4.2. */
  systemDays: number;
  /** Что идёт в деньги: корректировка, если она есть. */
  days: number;
  adjustment: UtilityDayAdjustment | null;
}

export interface UtilityPeriodView {
  period: UtilityPeriod;
  lines: UtilityLine[];
  total: number;
  /** Предварительное распределение: пересчитывается на каждый просмотр. */
  preview: UtilityDistribution;
  /** Снимок закрытого периода; у открытого — пусто. */
  allocations: UtilityAllocation[];
  /** Сутки по каждому участнику: расчётные и скорректированные. */
  participants: UtilityParticipantRow[];
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
 * Кто делит коммуналку месяца: все, кто занимал место в этом доме (§4.2
 * с поправкой от 30 сентября 2026).
 *
 * Участие определяет занятость койко-места, а не роль и не дата заселения:
 * админ дома с местом платит наравне со всеми, съехавший платит за свои
 * сутки, а жилец без места не платит вовсе. Прежний отбор шёл по проживаниям
 * и датам заселения — из-за этого админ и жильцы без даты заселения
 * выпадали из знаменателя, а их потребление раскладывалось на остальных.
 *
 * У каждого участника два числа суток: расчётное по занятости и то, что идёт
 * в деньги. Расходятся они, когда админ поставил корректировку (P2-6);
 * `override` подставляет ещё не сохранённое значение — так предпросмотр
 * считается тем же кодом, что и сам расчёт, а не вторым его списком.
 */
async function participantsOf(
  actor: UserActor,
  period: UtilityPeriod,
  executor: Executor,
  override?: { userId: string; days: number },
): Promise<UtilityParticipantRow[]> {
  const houseId = period.houseId;
  const month = period.month as BusinessDate;

  const [absences, stays, adjustments] = await Promise.all([
    listApprovedAbsences(
      actor.context,
      houseId,
      { from: startOfMonth(month), to: endOfMonth(month) },
      executor,
    ),
    listMonthStaysInHouse(actor.context, houseId, startOfMonth(month), executor),
    listDayAdjustments(period.id, executor),
  ]);

  const adjustmentOf = new Map(adjustments.map((entry) => [entry.userId, entry]));

  /*
   * Из дней вычитается только одобренный отъезд (§4.2): болезнь идёт
   * полностью, краткосрочное — тем более. День отъезда и день возвращения
   * прожиты, не считаются лишь дни строго между ними — и вычет идёт внутри
   * занятости места, поэтому в минус сутки уйти не могут.
   */
  const tripsByUser = new Map<string, { from: BusinessDate; to: BusinessDate }[]>();

  for (const absence of absences) {
    if (absence.type !== 'long' || absence.endDate === null) {
      continue;
    }

    const trips = tripsByUser.get(absence.userId) ?? [];
    trips.push({ from: absence.startDate as BusinessDate, to: absence.endDate as BusinessDate });
    tripsByUser.set(absence.userId, trips);
  }

  return (
    stays
      .map((stay) => {
        /*
         * Отъезды вычитаются внутри занятости места, а не из календаря:
         * иначе отъезд, начавшийся до заселения, уводил сутки в минус
         * (находка аудита 30 сентября 2026).
         */
        const systemDays = occupiedDaysInMonth({
          month,
          stays: stay.periods,
          moveOut: stay.moveOutDate === null ? null : (stay.moveOutDate as BusinessDate),
          absences: tripsByUser.get(stay.userId) ?? [],
        });

        const adjustment = adjustmentOf.get(stay.userId) ?? null;
        const pending = override?.userId === stay.userId ? override.days : null;

        return {
          userId: stay.userId,
          residencyId: stay.residencyId,
          systemDays,
          days: pending ?? adjustment?.days ?? systemDays,
          adjustment,
        };
      })
      /*
       * В списке остаётся тот, кто занимал место, и тот, о ком есть прямое
       * утверждение админа. Ноль суток из строя не выбывает: корректировка
       * «жил ноль дней» — это запись, которую админ должен видеть и мочь
       * переписать, а не исчезнувшая строка. Из денег ноль уходит сам —
       * делит только `distributeUtilities`.
       */
      .filter((entry) => entry.systemDays > 0 || entry.adjustment !== null || entry.days > 0)
      /*
       * Порядок участников — по числу суток, затем по жильцу. Занятости мест
       * приходят отсортированными по проживанию, а у заведённых одной
       * транзакцией порядок оставался на усмотрение планировщика, и
       * распределение показывалось людям каждый раз в новом виде.
       */
      .sort((left, right) =>
        left.days === right.days ? left.userId.localeCompare(right.userId) : left.days - right.days,
      )
  );
}

/** Период целиком: строки, итог, участники и распределение по ним. */
async function computePeriod(
  actor: UserActor,
  period: UtilityPeriod,
  executor: Executor,
  override?: { userId: string; days: number },
): Promise<{
  lines: UtilityLine[];
  total: number;
  participants: UtilityParticipantRow[];
  distribution: UtilityDistribution;
}> {
  const [lines, participants] = await Promise.all([
    listUtilityLines(period.id, executor),
    participantsOf(actor, period, executor, override),
  ]);

  const total = totalOf(lines);

  return {
    lines,
    total,
    participants,
    distribution: distributeUtilities(
      total,
      participants.map((entry) => ({ userId: entry.userId, days: entry.days })),
      period.houseDays,
    ),
  };
}

/**
 * Доля дома в человеко-днях (P2-7, указание владельца 27 сентября 2026).
 *
 * Число вводит администратор: система его не вычисляет и вычислить не может —
 * сколько человеко-суток «прожили» общие помещения, знает только тот, кто
 * видел дом. Комментарий обязателен, ноль — значение по умолчанию.
 *
 * Отрицательного значения не бывает: доля дома только уменьшает долю жильца,
 * увеличить её она не способна ни при каком значении. Это свойство самой
 * формулы (знаменатель растёт), и оно проверено перебором в тестах ядра.
 */
export async function setHouseDays(
  actor: UserActor,
  periodId: string,
  input: { days: number; comment: string },
  deps: UtilityDeps = {},
): Promise<UtilityPeriod> {
  const { executor } = resolve(deps);

  const period = await periodFor(actor, periodId, 'utility.manage', executor);
  assertDraft(period);

  if (!Number.isSafeInteger(input.days) || input.days < 0) {
    throw new ValidationError('utilities.errors.houseDaysInvalid');
  }

  /* Ноль снимает долю дома целиком — тогда и объяснять нечего. */
  const comment = input.comment.trim();

  if (input.days > 0 && comment === '') {
    throw new ValidationError('utilities.errors.commentRequired');
  }

  return withAudit(
    { context: actor.context, ip: actor.ip, requestId: actor.requestId },
    async (tx) => {
      const updated = await updateUtilityPeriod(
        actor.context,
        period.id,
        {
          houseDays: input.days,
          houseDaysComment: input.days === 0 ? null : comment,
        },
        tx,
      );

      if (updated === null) {
        throw new ConflictError('utilities.errors.notUpdated');
      }

      return {
        result: updated,
        audit: {
          action: AUDIT_ACTIONS.utilityHouseDaysSet,
          entityType: 'utility_period',
          entityId: period.id,
          before: { houseDays: period.houseDays, houseDaysComment: period.houseDaysComment },
          after: { houseDays: updated.houseDays, houseDaysComment: updated.houseDaysComment },
        },
      };
    },
    executor,
  );
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

/**
 * Период дома за месяц, если он заведён. Отличается от `openUtilityPeriod`
 * тем, что ничего не создаёт: экран открывают и просто посмотреть, а показ
 * месяца не должен оставлять за собой пустой черновик периода.
 */
export async function findPeriodOfMonth(
  actor: UserActor,
  houseId: string,
  month: BusinessDate,
  deps: UtilityDeps = {},
): Promise<UtilityPeriod | null> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'utility.read', { houseId });

  return findUtilityPeriod(actor.context, houseId, startOfMonth(month), executor);
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

  const [computed, allocations] = await Promise.all([
    computePeriod(actor, period, executor),
    listUtilityAllocations(period.id, executor),
  ]);

  return {
    period,
    lines: computed.lines,
    total: computed.total,
    preview: computed.distribution,
    allocations,
    participants: computed.participants,
  };
}

/**
 * Пересчёт периода с подставленным числом суток — до сохранения (P2-6).
 *
 * Отдельного расчёта у предпросмотра нет: это тот же `computePeriod`
 * с одним заменённым значением. Второй список формул рано или поздно
 * разошёлся бы с первым, и разошёлся бы молча — в деньгах.
 */
export async function previewDayCorrection(
  actor: UserActor,
  periodId: string,
  override: { userId: string; days: number },
  deps: UtilityDeps = {},
): Promise<{
  period: UtilityPeriod;
  total: number;
  participants: UtilityParticipantRow[];
  distribution: UtilityDistribution;
}> {
  const { executor } = resolve(deps);

  const period = await periodFor(actor, periodId, 'utility.manage', executor);

  /*
   * Негодное число суток отсекается и в предпросмотре: иначе `splitCeil`
   * упал бы на NaN, и отказ назвал бы «не удалось выполнить действие»
   * вместо причины. Комментарий на этом шаге не нужен — он нужен на записи.
   */
  const problem = checkDayCorrection({
    month: period.month as BusinessDate,
    systemDays: override.days,
    days: override.days,
    comment: 'предпросмотр',
    confirmIncrease: false,
  });

  if (problem !== null) {
    throw new ValidationError(`utilities.errors.${problem}`);
  }

  const computed = await computePeriod(actor, period, executor, override);

  return {
    period,
    total: computed.total,
    participants: computed.participants,
    distribution: computed.distribution,
  };
}

/**
 * Ручная корректировка суток жильца (P2-6, указание владельца
 * 27 сентября 2026).
 *
 * Инструмент постоянный: он нужен каждый январь, когда жильцы разъезжаются
 * на каникулы, не оформляя отсутствие, а отопление горит. Поэтому ни флага
 * «только первый период», ни разовой миграции здесь нет.
 *
 * Расчётное значение сохраняется рядом со введённым, а не затирается:
 * иначе через месяц никто не отличит «админ так решил» от «так посчитала
 * формула». Правила самой правки — в `checkDayCorrection`.
 */
export async function correctUtilityDays(
  actor: UserActor,
  input: {
    periodId: string;
    userId: string;
    days: number;
    comment: string;
    confirmIncrease: boolean;
  },
  deps: UtilityDeps = {},
): Promise<UtilityDayAdjustment> {
  const { executor } = resolve(deps);

  const period = await periodFor(actor, input.periodId, 'utility.manage', executor);
  assertDraft(period);

  const participants = await participantsOf(actor, period, executor);
  const target = participants.find((entry) => entry.userId === input.userId);

  if (target === undefined) {
    throw new NotFoundError('Жилец не участвует в распределении этого периода');
  }

  const problem = checkDayCorrection({
    month: period.month as BusinessDate,
    systemDays: target.systemDays,
    days: input.days,
    comment: input.comment,
    confirmIncrease: input.confirmIncrease,
  });

  if (problem !== null) {
    throw new ValidationError(`utilities.errors.${problem}`);
  }

  return withAudit(
    { context: actor.context, ip: actor.ip, requestId: actor.requestId },
    async (tx) => {
      const saved = await saveDayAdjustment(
        {
          periodId: period.id,
          userId: input.userId,
          systemDays: target.systemDays,
          days: input.days,
          comment: input.comment.trim(),
          createdBy: actor.context.userId,
        },
        tx,
      );

      return {
        result: saved,
        /*
         * В журнале оба значения: что считала система и что поставил админ.
         * Одного «стало 12» мало — через месяц не восстановить, от чего
         * отсчитывали, а спор будет именно об этом.
         *
         * `systemDays` стоит только в «до» намеренно: журнал пишет лишь
         * изменившиеся поля, и значение, одинаковое с двух сторон, из записи
         * выпало бы целиком. Проверено тестом, а не предположено.
         */
        audit: {
          action: AUDIT_ACTIONS.utilityDaysCorrected,
          entityType: 'utility_day_adjustment',
          entityId: saved.id,
          before: {
            days: target.adjustment?.days ?? target.systemDays,
            systemDays: target.systemDays,
          },
          after: {
            days: saved.days,
            comment: saved.comment,
            userId: saved.userId,
            month: period.month,
          },
        },
      };
    },
    executor,
  );
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
  const { total, participants, distribution } = await computePeriod(actor, period, executor);

  /*
   * Ноль — законный итог месяца, а не ошибка: дом мог не платить вовсе
   * (указание владельца, 22 сентября 2026). Закрытый нулевой период говорит
   * «за этот месяц коммуналки не было» — это утверждение, и оно должно
   * попадать в историю. Долей по нулю никому не пишется: строка счёта
   * на ноль тенге — мусор в документе жильца, а не запись о нуле.
   *
   * Делить не на кого — по-прежнему отказ, но только когда делить есть что:
   * сумма, которую не на кого разложить, потерялась бы молча.
   */
  if (total > 0 && distribution.allocations.length === 0 && distribution.house.days === 0) {
    throw new ConflictError('utilities.errors.noParticipants');
  }

  const byUser = new Map(participants.map((entry) => [entry.userId, entry.residencyId]));
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
      {
        status: 'closed',
        closedAt: instant,
        closedBy: actor.context.userId,
        /* Доля дома фиксируется снимком наравне с долями жильцов. */
        houseAmount: distribution.house.amount,
      },
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

    /*
     * Доля дома — расход Исполнителя, а не долг жильца: она идёт проводкой
     * на счёт дома (§10.1) и ни в один счёт не попадает. Проводка при
     * закрытии, как и излишек: с этого момента коммунальный фонд должен
     * поставщику итог периода, а часть его причитается от дома.
     */
    if (distribution.house.amount > 0) {
      await postUtilityHouseShare(
        actor,
        {
          houseId: period.houseId,
          sourceId: period.id,
          amount: distribution.house.amount,
          date: today,
        },
        { executor: tx, today },
      );
    }

    let invoiced = 0;

    for (const allocation of distribution.allocations) {
      const residencyId = byUser.get(allocation.userId);

      if (residencyId === undefined || allocation.amount <= 0) {
        continue;
      }

      const line = {
        kind: 'utilities' as const,
        title: `Коммунальные услуги за ${month.slice(0, 7)}`,
        amount: allocation.amount,
      };

      const existing = await listInvoices(
        actor.context,
        { residencyId, type: 'monthly', periodMonth: invoiceMonth },
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
            residencyId,
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
          houseDays: distribution.house.days,
          houseAmount: distribution.house.amount,
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
 *
 * Проводки периода — излишек округления и доля дома — отменяются сторно.
 * Без этого повторное закрытие клало их вторым разом: до появления доли дома
 * так удваивался излишек, и заметить это было нечем. Корректировки суток
 * остаются: они относятся к людям и суткам, а не к строкам расходов.
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

    const entries = await listLedgerEntriesBySource(actor.context, 'utilities', period.id, tx);

    for (const entry of entries) {
      await reverseEntry(actor, entry.id, { executor: tx });
    }

    const reopened = await updateUtilityPeriod(
      actor.context,
      period.id,
      { status: 'draft', closedAt: null, closedBy: null, houseAmount: 0 },
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

/**
 * Чеки закрытых периодов месяца для жильца (указание владельца,
 * 25 сентября 2026).
 *
 * В счёте у жильца есть строка коммуналки, а приложенный админом чек ему
 * был недоступен. Чек — это расход дома, а не данные других жильцов,
 * поэтому он показывается: у закрытого периода того дома, где жилец жил.
 * У открытого периода чеков не отдаём — расчёт там ещё меняется.
 */
export async function listUtilityReceiptsFor(
  actor: UserActor,
  target: { userId: string; month: BusinessDate },
  deps: UtilityDeps = {},
): Promise<{ fileId: string; title: string }[]> {
  const { executor } = resolve(deps);

  return listClosedReceipts(actor.context, target.userId, startOfMonth(target.month), executor);
}

/**
 * Раскладка доли коммуналки для жильца (Приложение №3 п. 4.4).
 *
 * В счёте была одна строка с суммой, и по ней нельзя было проверить ничего:
 * ни за сколько суток посчитано, ни из какого итога сложилась доля
 * (находка P2-6, 27 сентября 2026).
 */
export async function readUtilityShareFor(
  actor: UserActor,
  target: { userId: string; month: BusinessDate },
  deps: UtilityDeps = {},
): Promise<ResidentUtilityShare | null> {
  const { executor } = resolve(deps);

  return findResidentShare(actor.context, target.userId, startOfMonth(target.month), executor);
}

/** Первое число месяца, к которому относится дата: для экрана периода. */
export { monthOf };
