import { and, asc, eq } from 'drizzle-orm';

import { getDb, type Executor } from '@/db/client';
import { parsePeriod } from '@/db/period';
import { claimJobRun, finishJobRun } from '@/db/repositories/job-runs';
import { listDepositTransactions, listInvoices } from '@/db/repositories/invoices';
import { updateFine } from '@/db/repositories/rating';
import { listAssignments, listResidencies } from '@/db/repositories/residencies';
import { organizations, users } from '@/db/schema';
import { depositBalance } from '@/domain/invoice';
import { buildMonthlyInvoice, rentForMonth } from '@/domain/monthly-invoice';
import { logger } from '@/lib/logger';
import { now, startOfMonth, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { createInvoice, utilitiesLineFor } from './invoices';
import { discountForMonth, pendingFinesForMonth } from './rating';

import type { AccessContext } from '@/db/access';
import type { UserActor } from './users';

/**
 * Автогенерация месячных счетов (docs/03-BUSINESS-RULES.md §3,
 * docs/01-ARCHITECTURE.md — задание `invoices-monthly`, 1 числа в 00:05).
 *
 * Состав счёта собирают чистые функции `src/domain/monthly-invoice.ts`.
 * Здесь — обход сети и две защиты от дублей: строка в `job_runs` на месяц
 * и проверка «счёт за этот месяц уже есть» на каждом проживании. Одной мало:
 * оборвавшийся посередине прогон обязан довести начатое, не удвоив сделанное.
 *
 * Коммуналка идёт из закрытого периода прошлого месяца, штрафы — из тех,
 * что начислены до этого месяца и ещё не применены, скидка — наибольшая
 * подтверждённая, если рейтинг держит её порог (§3, §5.4).
 */
export const MONTHLY_INVOICES_JOB = 'invoices-monthly';

export interface MonthlyRunDeps {
  executor?: Executor;
  /** Момент запуска; из него выводится месяц по календарю Алматы. */
  instant?: Date;
}

export interface MonthlyRunResult {
  /** Первое число месяца, за который выставлены счета. */
  month: BusinessDate;
  created: number;
  /** Проживания, у которых счёт за этот месяц уже был. */
  existing: number;
  /** Прогон за этот месяц уже завершён: задание ничего не делало. */
  skipped: boolean;
}

/**
 * Задание исполняется от имени суперадмина сети: своего пользователя
 * у планировщика нет, а права на выставление счетов нужны. Автора
 * у сгенерированного счёта нет — `created_by` остаётся пустым, и по нему
 * автоматический счёт отличается от выставленного руками ([ОТКРЫТО] P3-16).
 */
async function actorForOrg(orgId: string, executor: Executor): Promise<UserActor | null> {
  const [superadmin] = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, 'superadmin')))
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (superadmin === undefined) {
    return null;
  }

  const context: AccessContext = {
    orgId,
    userId: superadmin.id,
    role: 'superadmin',
    houseId: null,
  };

  return { context, requestId: `job:${MONTHLY_INVOICES_JOB}` };
}

/** Строки счёта одного проживания за месяц; `null` — счёт уже есть. */
async function draftFor(
  actor: UserActor,
  residency: { id: string; houseId: string; userId: string },
  month: BusinessDate,
  executor: Executor,
) {
  const residencyId = residency.id;
  const existing = await listInvoices(
    actor.context,
    { residencyId, type: 'monthly', periodMonth: month },
    executor,
  );

  if (existing.some((invoice) => invoice.status !== 'cancelled')) {
    return null;
  }

  const [assignments, transactions] = await Promise.all([
    listAssignments(residencyId, executor),
    listDepositTransactions(actor.context, residencyId, {}, executor),
  ]);

  const rent = rentForMonth(
    month,
    assignments.map((assignment) => {
      const period = parsePeriod(assignment.period);

      return { price: assignment.price, from: period.from, to: period.to };
    }),
  );

  const balance = depositBalance(transactions.map((transaction) => transaction.amount));

  /*
   * Коммуналка идёт за прошлый месяц и только из закрытого периода (§3, §4).
   * Период, закрытый позже, допишет строку в этот же счёт сам.
   */
  const utilities = await utilitiesLineFor(
    actor.context,
    { houseId: residency.houseId, userId: residency.userId, invoiceMonth: month },
    executor,
  );

  /*
   * Штрафы попадают в ближайший счёт (§3): те, что начислены до первого
   * числа этого месяца. Начисленный после — ждёт следующего, иначе жилец
   * узнавал бы о наказании из счёта, выставленного раньше самого штрафа.
   */
  const [fines, discount] = await Promise.all([
    pendingFinesForMonth(actor, { userId: residency.userId, month }, { executor }),
    discountForMonth(actor, { userId: residency.userId, month }, { executor }),
  ]);

  const draft = buildMonthlyInvoice({
    month,
    rent,
    utilities: utilities === null ? null : { amount: utilities.amount, title: utilities.title },
    fines: fines.map((fine) => ({ title: fineTitle(fine.reason), amount: fine.amount })),
    // Перерасход депозита переносится в ближайший месячный счёт (§2.4).
    depositDebt: balance < 0 ? -balance : 0,
    discount: discount > 0 ? { title: 'Скидка за рейтинг', amount: discount } : null,
  });

  return { ...draft, fineIds: fines.map((fine) => fine.id) };
}

/** Заголовок строки штрафа: пороговый называет порог, ручной — свою причину. */
function fineTitle(reason: string): string {
  const threshold = reason.startsWith('rating.threshold:')
    ? reason.slice('rating.threshold:'.length)
    : null;

  return threshold === null ? `Штраф: ${reason}` : `Штраф: рейтинг ниже ${threshold}`;
}

/**
 * Прогон задания по всей сети. Каждое проживание обрабатывается своей
 * транзакцией внутри `createInvoice`: один сбойный счёт не должен отменять
 * уже выставленные — иначе повтор начинал бы всё заново.
 */
export async function generateMonthlyInvoices(
  deps: MonthlyRunDeps = {},
): Promise<MonthlyRunResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  // «Первое число» — по календарю Алматы: в UTC это ещё прошлый месяц.
  const month = startOfMonth(todayInAlmaty(instant));
  const log = logger.child({ job: MONTHLY_INVOICES_JOB, month });

  const run = await claimJobRun(MONTHLY_INVOICES_JOB, month, executor);

  if (run === null) {
    log.info('прогон за этот месяц уже завершён');

    return { month, created: 0, existing: 0, skipped: true };
  }

  let created = 0;
  let existing = 0;

  try {
    const orgs = await executor.select({ id: organizations.id }).from(organizations);

    for (const org of orgs) {
      const actor = await actorForOrg(org.id, executor);

      if (actor === null) {
        log.warn({ orgId: org.id }, 'в сети нет суперадмина: счета не выставлены');
        continue;
      }

      const residencies = await listResidencies(actor.context, { status: 'active' }, executor);

      for (const residency of residencies) {
        const draft = await draftFor(actor, residency, month, executor);

        if (draft === null) {
          existing += 1;
          continue;
        }

        const invoice = await createInvoice(
          actor,
          {
            residencyId: residency.id,
            type: 'monthly',
            periodMonth: month,
            dueDate: month,
            createdBy: null,
            lines: draft.lines,
          },
          { executor, today: month },
        );

        // Штраф, попавший в счёт, больше не ждёт своей очереди (§3).
        for (const fineId of draft.fineIds) {
          await updateFine(
            actor.context,
            fineId,
            { status: 'applied', invoiceId: invoice.id },
            executor,
          );
        }

        created += 1;
      }
    }
  } catch (error) {
    await finishJobRun(run.id, 'failed', { error: String(error) }, executor);
    throw error;
  }

  await finishJobRun(run.id, 'done', { created, existing }, executor);
  log.info({ created, existing }, 'месячные счета выставлены');

  return { month, created, existing, skipped: false };
}
