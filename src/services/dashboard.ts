import { getDb, type Executor } from '@/db/client';
import { listResidencies } from '@/db/repositories/residencies';
import {
  addDays,
  differenceInDays,
  now,
  startOfMonth,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import { readDepositView } from './deposits';
import { listDocumentCards } from './documents';
import { listBedOccupantsOn } from '@/db/repositories/rotations';
import { listBeds } from '@/db/repositories/areas';
import { listDocuments } from '@/db/repositories/documents';
import { listHouses } from '@/db/repositories/houses';
import { listDiscounts, listFines } from '@/db/repositories/rating';
import { listUtilityPeriods } from '@/db/repositories/utilities';
import { listInvoicesFor } from './invoices';
import { readHouseRating, readMyRatingCard, type HouseRatingRow } from './rating-views';
import { readHoleDecisions, type HoleDecision } from './rotation-decisions';
import { REFUND_DEADLINE_DAYS } from './expiry-reminders';
import { listRemoteTasks } from './remote';
import { readRotationStats } from './rotation-stats';
import { readCalendar } from './rotation-calendar';
import { listPeriodsOfHouse } from './utilities';
import { readOnboarding } from './onboarding';

import type { OnboardingStepKey } from './onboarding';
import type { UserActor } from './users';

/**
 * Дэшборд жильца (docs/04-MODULES/09-dashboards.md, «Жилец»).
 *
 * Шесть блоков одного экрана собираются здесь, а не в разметке: страница
 * не должна знать, что «ближайшая уборка» — это календарь, отфильтрованный
 * по себе, а «требуется внимание» — документы и незакрытые шаги заселения.
 */
export interface DashboardDeps {
  executor?: Executor;
  today?: BusinessDate;
}

/** Насколько вперёд ищется ближайшая уборка: две недели цикла ротаций. */
const LOOKAHEAD_DAYS = 14;

/** Сколько движений депозита показывать: последние, не всю историю. */
const DEPOSIT_TRANSACTIONS = 3;

/** Со скольких дней срок документа попадает в «Требуется внимание». */
const DOCUMENT_ATTENTION_DAYS = 30;

export interface NextCleaning {
  assignmentId: string;
  date: BusinessDate;
  areaName: string;
  checklistTitle: string;
  /**
   * Подтвердить можно в день уборки и на следующий: до 23:55 следующего
   * дня, когда автозакрытие отметит её невыполненной (§7).
   */
  canConfirm: boolean;
  confirmed: boolean;
}

export interface DashboardInvoice {
  invoiceId: string;
  total: number;
  remaining: number;
  dueDate: BusinessDate;
  status: string;
  overdue: boolean;
}

export interface DashboardDeposit {
  balance: number;
  transactions: { id: string; type: string; amount: number; createdAt: Date }[];
}

export interface AttentionDocument {
  /** Название типа во всех локалях: выбирает язык читающий. */
  title: unknown;
  reason: 'rejected' | 'expiring' | 'expired' | 'missing';
  daysLeft: number | null;
}

export interface ResidentDashboard {
  residencyId: string;
  nextCleaning: NextCleaning | null;
  invoice: DashboardInvoice | null;
  deposit: DashboardDeposit;
  rating: { value: number | null; visible: boolean; debts: number };
  attention: {
    documents: AttentionDocument[];
    steps: OnboardingStepKey[];
  };
}

function resolve(deps: DashboardDeps): { executor: Executor; today: BusinessDate } {
  return {
    executor: deps.executor ?? getDb(),
    today: deps.today ?? todayInAlmaty(now()),
  };
}

/** Ближайшая своя уборка: первая по дате, начиная с сегодняшнего дня. */
async function nextCleaningOf(
  actor: UserActor,
  today: BusinessDate,
  executor: Executor,
): Promise<NextCleaning | null> {
  const calendar = await readCalendar(
    actor,
    { from: addDays(today, -1), to: addDays(today, LOOKAHEAD_DAYS) },
    { executor },
  );

  const areas = new Map(calendar.dictionaries.areas.map((area) => [area.id, area.name]));
  const checklists = new Map(
    calendar.dictionaries.checklists.map((checklist) => [checklist.id, checklist.title]),
  );

  const mine = calendar.occurrences
    .filter((item) => item.occurrence.status === 'scheduled')
    .flatMap((item) =>
      item.assignments
        .filter((assignment) => assignment.userId === actor.context.userId)
        .map((assignment) => ({ occurrence: item.occurrence, assignment })),
    )
    .sort((left, right) => left.occurrence.date.localeCompare(right.occurrence.date));

  /*
   * Вчерашняя неподтверждённая важнее завтрашней: её ещё можно закрыть
   * сегодня, а завтра автозакрытие отметит её невыполненной.
   */
  const pending = mine.find(
    (item) => item.occurrence.date < today && item.assignment.state === 'assigned',
  );
  const upcoming = mine.find((item) => item.occurrence.date >= today);
  const chosen = pending ?? upcoming;

  if (chosen === undefined) {
    return null;
  }

  const date = chosen.occurrence.date as BusinessDate;

  return {
    assignmentId: chosen.assignment.id,
    date,
    areaName: areas.get(chosen.occurrence.areaId) ?? '',
    checklistTitle: checklists.get(chosen.occurrence.checklistId) ?? '',
    canConfirm:
      chosen.assignment.state === 'assigned' && date <= today && addDays(date, 1) >= today,
    confirmed: chosen.assignment.state === 'confirmed',
  };
}

/** Счёт, который ждёт денег: самый ранний неоплаченный. */
async function openInvoiceOf(
  actor: UserActor,
  residencyId: string,
  deps: { executor: Executor; today: BusinessDate },
): Promise<DashboardInvoice | null> {
  const rows = await listInvoicesFor(actor, { residencyId }, deps);

  const open = rows
    .filter((row) => row.invoice.status !== 'paid' && row.invoice.status !== 'cancelled')
    .sort((left, right) => (left.invoice.dueDate ?? '').localeCompare(right.invoice.dueDate ?? ''))
    .find((row) => row.invoice.dueDate !== null);

  if (open === undefined || open.invoice.dueDate === null) {
    return null;
  }

  return {
    invoiceId: open.invoice.id,
    total: open.invoice.total,
    remaining: open.remaining,
    dueDate: open.invoice.dueDate as BusinessDate,
    status: open.invoice.status,
    overdue: open.overdue,
  };
}

/** Что требует внимания в документах: отклонённое, просроченное, истекающее. */
async function documentsNeedingAttention(
  actor: UserActor,
  residencyId: string,
  deps: { executor: Executor; today: BusinessDate },
): Promise<AttentionDocument[]> {
  const cards = await listDocumentCards(actor, residencyId, deps);
  const attention: AttentionDocument[] = [];

  for (const card of cards) {
    const title = card.type.nameI18n;

    if (card.document === null) {
      if (card.type.isRequired) {
        attention.push({ title, reason: 'missing', daysLeft: null });
      }

      continue;
    }

    if (card.document.status === 'rejected') {
      attention.push({ title, reason: 'rejected', daysLeft: card.daysLeft });
      continue;
    }

    if (card.validity === 'expired') {
      attention.push({ title, reason: 'expired', daysLeft: card.daysLeft });
      continue;
    }

    if (card.daysLeft !== null && card.daysLeft <= DOCUMENT_ATTENTION_DAYS) {
      attention.push({ title, reason: 'expiring', daysLeft: card.daysLeft });
    }
  }

  return attention;
}

export async function readResidentDashboard(
  actor: UserActor,
  deps: DashboardDeps = {},
): Promise<ResidentDashboard | null> {
  const { executor, today } = resolve(deps);

  const [residency] = await listResidencies(
    actor.context,
    { userId: actor.context.userId },
    executor,
  );

  if (residency === undefined) {
    return null;
  }

  const [cleaning, invoice, deposit, rating, documents, onboarding] = await Promise.all([
    nextCleaningOf(actor, today, executor),
    openInvoiceOf(actor, residency.id, { executor, today }),
    readDepositView(actor, residency.id, {}, { executor, today }),
    readMyRatingCard(actor, { executor, today }),
    documentsNeedingAttention(actor, residency.id, { executor, today }),
    readOnboarding({ context: actor.context }, { executor, today }),
  ]);

  return {
    residencyId: residency.id,
    nextCleaning: cleaning,
    invoice,
    deposit: {
      balance: deposit.balance,
      transactions: deposit.transactions.slice(0, DEPOSIT_TRANSACTIONS).map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        amount: transaction.amount,
        createdAt: transaction.createdAt,
      })),
    },
    rating: {
      value: rating?.rating ?? null,
      visible: rating?.visible ?? false,
      debts: rating?.debts ?? 0,
    },
    attention: {
      documents,
      steps: onboarding.steps.filter((step) => !step.done).map((step) => step.key),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Дэшборд админа дома (docs/04-MODULES/09-dashboards.md, «Админ дома»)
 * ------------------------------------------------------------------ */

export interface TodayCleaning {
  occurrenceId: string;
  areaName: string;
  checklistTitle: string;
  workers: { assignmentId: string; name: string; state: string }[];
}

export interface DecisionItem {
  assignmentId: string;
  date: BusinessDate;
  areaName: string;
  /** `needs_reassignment` — дыра в расписании, `assigned` — вчерашняя без отметки. */
  kind: 'needs_reassignment' | 'unconfirmed';
  name: string | null;
}

export interface HouseMoney {
  month: BusinessDate;
  issued: number;
  paid: number;
  debt: number;
  debtors: { residencyId: string; name: string; remaining: number; overdue: boolean }[];
  /** Счета жильцов с Kaspi, по которым ждут перевода (модуль 2, «Удалёнка»). */
  remoteTasks: number;
}

export interface HouseDashboard {
  houseId: string;
  today: BusinessDate;
  cleanings: TodayCleaning[];
  /** Вчерашние уборки без отметки: сегодня их последний день (§7). */
  decisions: DecisionItem[];
  /** Дырки расписания с причиной и вариантами (план фазы 10 §2.8). */
  holes: HoleDecision[];
  money: HouseMoney;
  rating: { average: number | null; best: HouseRatingRow[]; worst: HouseRatingRow[] };
  utilities: { month: BusinessDate; status: 'missing' | 'draft' | 'closed' };
  onboarding: {
    moveIn: { residencyId: string; name: string; status: string }[];
    documents: number;
  };
}

/** Сколько имён показывать в списках «лучшие» и «худшие». */
const RATING_EDGE = 3;

/**
 * Сколько справок дома истекает в ближайший месяц.
 *
 * Порог тот же, с которого предупреждает `documents-expiry`: экран дома
 * и напоминание не должны расходиться в том, что считать срочным (P6-31).
 */
function expiringSoon(
  documents: readonly { residencyId: string; validUntil: string | null }[],
  residencies: readonly { id: string }[],
  today: BusinessDate,
): number {
  const ofHouse = new Set(residencies.map((item) => item.id));
  const edge = addDays(today, DOCUMENT_ATTENTION_DAYS);

  return documents.filter(
    (document) =>
      ofHouse.has(document.residencyId) &&
      document.validUntil !== null &&
      document.validUntil <= edge,
  ).length;
}

function nameOf(members: Map<string, string>, userId: string | null): string | null {
  return userId === null ? null : (members.get(userId) ?? null);
}

export async function readHouseDashboard(
  actor: UserActor,
  houseId: string,
  deps: DashboardDeps = {},
): Promise<HouseDashboard> {
  const { executor, today } = resolve(deps);
  const month = startOfMonth(today);
  const yesterday = addDays(today, -1);

  const calendar = await readCalendar(actor, { from: yesterday, to: today }, { executor, houseId });

  const areas = new Map(calendar.dictionaries.areas.map((area) => [area.id, area.name]));
  const checklists = new Map(
    calendar.dictionaries.checklists.map((checklist) => [checklist.id, checklist.title]),
  );
  const members = new Map(
    calendar.dictionaries.members.map((member) => [member.userId, member.name]),
  );

  const cleanings: TodayCleaning[] = calendar.occurrences
    .filter((item) => item.occurrence.date === today && item.occurrence.status !== 'cancelled')
    .map((item) => ({
      occurrenceId: item.occurrence.id,
      areaName: areas.get(item.occurrence.areaId) ?? '',
      checklistTitle: checklists.get(item.occurrence.checklistId) ?? '',
      workers: item.assignments.map((assignment) => ({
        assignmentId: assignment.id,
        name: nameOf(members, assignment.userId) ?? '',
        state: assignment.state,
      })),
    }));

  /*
   * Требует решения ровно две вещи: дырка в расписании — она идёт отдельным
   * списком с причиной и вариантами (`holes`), — и вчерашняя уборка без
   * отметки, у которой сегодня последний день (§7). Остальное система
   * разбирает сама.
   */
  const decisions: DecisionItem[] = calendar.occurrences
    .filter((item) => item.occurrence.status === 'scheduled')
    .flatMap((item) =>
      item.assignments
        .filter(
          (assignment) => assignment.state === 'assigned' && item.occurrence.date === yesterday,
        )
        .map((assignment) => ({
          assignmentId: assignment.id,
          date: item.occurrence.date as BusinessDate,
          areaName: areas.get(item.occurrence.areaId) ?? '',
          kind:
            assignment.state === 'needs_reassignment'
              ? ('needs_reassignment' as const)
              : ('unconfirmed' as const),
          name: nameOf(members, assignment.userId),
        })),
    );

  const [invoices, remote, rating, periods, residencies, documents, holes] = await Promise.all([
    listInvoicesFor(actor, { houseId, periodMonth: month }, { executor, today }),
    listRemoteTasks(actor, { houseId }, { executor, today }),
    readHouseRating(actor, houseId, { executor, today }),
    listPeriodsOfHouse(actor, houseId, { executor, today }),
    listResidencies(actor.context, { houseId }, executor),
    listDocuments(actor.context, { status: 'approved' }, executor),
    readHoleDecisions(actor, houseId, { executor, today }),
  ]);

  const issued = invoices.reduce((sum, row) => sum + row.invoice.total, 0);
  const paid = invoices.reduce((sum, row) => sum + row.paid, 0);

  const names = new Map(rating.map((row) => [row.userId, row.name]));
  const byResidency = new Map(residencies.map((item) => [item.id, item]));

  const debtors = invoices
    .filter((row) => row.remaining > 0)
    .map((row) => ({
      residencyId: row.invoice.residencyId,
      name: names.get(byResidency.get(row.invoice.residencyId)?.userId ?? '') ?? '',
      remaining: row.remaining,
      overdue: row.overdue,
    }));

  const ordered = [...rating].sort((left, right) => right.rating - left.rating);
  const average =
    rating.length === 0
      ? null
      : Math.round(rating.reduce((sum, row) => sum + row.rating, 0) / rating.length);

  const period = periods.find((item) => item.month === month);

  return {
    houseId,
    today,
    cleanings,
    decisions,
    holes,
    money: {
      month,
      issued,
      paid,
      debt: issued - paid,
      debtors,
      remoteTasks: remote.filter((task) => !task.sent).length,
    },
    rating: {
      average,
      best: ordered.slice(0, RATING_EDGE),
      worst: ordered.slice(-RATING_EDGE).reverse(),
    },
    utilities: {
      month,
      status: period === undefined ? 'missing' : period.status === 'closed' ? 'closed' : 'draft',
    },
    onboarding: {
      moveIn: residencies
        .filter((item) => item.status !== 'active' && item.status !== 'archived')
        .map((item) => ({
          residencyId: item.id,
          name: names.get(item.userId) ?? '',
          status: item.status,
        })),
      documents: expiringSoon(documents, residencies, today),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Дэшборд суперадмина (docs/04-MODULES/09-dashboards.md, «Суперадмин»)
 * ------------------------------------------------------------------ */

export interface NetworkHouseRow {
  houseId: string;
  name: string;
  /** Занято мест из всего: занятость показывается числами, а не процентом. */
  beds: { taken: number; total: number };
  issued: number;
  paid: number;
  debt: number;
  rating: number | null;
  /** Средняя оценка уборок за текущий месяц; `null` — оценок не было. */
  cleaningScore: number | null;
}

export interface RefundWatchRow {
  residencyId: string;
  houseName: string;
  deadline: BusinessDate;
  /** Отрицательное — просрочка. */
  daysLeft: number;
  balance: number;
}

export interface NetworkDecisions {
  /** Скидки ждут подтверждения суперадмина: система их только предлагает (§5.4). */
  discounts: number;
  /** Штрафы, ещё не попавшие в счёт: их можно отменить. */
  fines: number;
  /** Незакрытые периоды коммуналки за прошедшие месяцы. */
  utilityPeriods: { periodId: string; houseName: string; month: BusinessDate }[];
}

export interface NetworkDashboard {
  today: BusinessDate;
  month: BusinessDate;
  houses: NetworkHouseRow[];
  refunds: RefundWatchRow[];
  decisions: NetworkDecisions;
}

export async function readNetworkDashboard(
  actor: UserActor,
  deps: DashboardDeps = {},
): Promise<NetworkDashboard> {
  const { executor, today } = resolve(deps);
  const month = startOfMonth(today);

  const houses = await listHouses(actor.context, {}, executor);
  const rows: NetworkHouseRow[] = [];

  for (const house of houses) {
    const [beds, occupants, invoices, rating, stats] = await Promise.all([
      listBeds(actor.context, house.id, {}, executor),
      listBedOccupantsOn(actor.context, house.id, today, executor),
      listInvoicesFor(actor, { houseId: house.id, periodMonth: month }, { executor, today }),
      readHouseRating(actor, house.id, { executor, today }),
      readRotationStats(actor, house.id, { from: month, to: today }, { executor }),
    ]);

    const issued = invoices.reduce((sum, row) => sum + row.invoice.total, 0);
    const paid = invoices.reduce((sum, row) => sum + row.paid, 0);
    const scored = stats.months.find((item) => item.month === month);

    rows.push({
      houseId: house.id,
      name: house.name,
      beds: { taken: occupants.length, total: beds.length },
      issued,
      paid,
      debt: issued - paid,
      rating:
        rating.length === 0
          ? null
          : Math.round(rating.reduce((sum, row) => sum + row.rating, 0) / rating.length),
      cleaningScore: scored?.averageScore ?? null,
    });
  }

  const names = new Map(houses.map((house) => [house.id, house.name]));
  const terminating = await listResidencies(actor.context, { status: 'terminating' }, executor);
  const refunds: RefundWatchRow[] = [];

  for (const residency of terminating) {
    if (residency.terminationRequestedAt === null) {
      continue;
    }

    const deadline = addDays(todayInAlmaty(residency.terminationRequestedAt), REFUND_DEADLINE_DAYS);
    const view = await readDepositView(actor, residency.id, {}, { executor, today });

    refunds.push({
      residencyId: residency.id,
      houseName: names.get(residency.houseId) ?? '',
      deadline,
      daysLeft: differenceInDays(today, deadline),
      balance: view.balance,
    });
  }

  const [discounts, fines, periods] = await Promise.all([
    listDiscounts(actor.context, { status: 'proposed' }, executor),
    listFines(actor.context, { status: 'pending' }, executor),
    listUtilityPeriods(actor.context, { status: 'draft' }, executor),
  ]);

  return {
    today,
    month,
    houses: rows,
    refunds: refunds.sort((left, right) => left.daysLeft - right.daysLeft),
    decisions: {
      discounts: discounts.length,
      fines: fines.length,
      /*
       * Переоткрытый период по данным неотличим от просто незакрытого:
       * статус у обоих `draft`, а сам факт переоткрытия живёт в журнале.
       * Поэтому здесь — все незакрытые периоды прошедших месяцев: и те,
       * которые открыли заново, и те, которые не закрыли вовремя (P6-33).
       */
      utilityPeriods: periods
        .filter((period) => period.month < month)
        .map((period) => ({
          periodId: period.id,
          houseName: names.get(period.houseId) ?? '',
          month: period.month as BusinessDate,
        })),
    },
  };
}
