import { getDb, type Executor } from '@/db/client';
import { listResidencies } from '@/db/repositories/residencies';
import { addDays, now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { readDepositView } from './deposits';
import { listDocumentCards } from './documents';
import { listInvoicesFor } from './invoices';
import { readMyRatingCard } from './rating-views';
import { readCalendar } from './rotation-calendar';
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
  rating: { value: number | null; visible: boolean };
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
    rating: { value: rating?.rating ?? null, visible: rating?.visible ?? false },
    attention: {
      documents,
      steps: onboarding.steps.filter((step) => !step.done).map((step) => step.key),
    },
  };
}
