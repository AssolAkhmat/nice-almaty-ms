import { getDb, type Executor } from '@/db/client';
import { listDocumentTypes, listDocuments } from '@/db/repositories/documents';
import { listHouses } from '@/db/repositories/houses';
import { claimJobRun, finishJobRun } from '@/db/repositories/job-runs';
import { listResidencies } from '@/db/repositories/residencies';
import { type Locale } from '@/lib/i18n/config';
import { notificationTexts } from '@/lib/i18n/notification-texts';
import { logger } from '@/lib/logger';
import { addDays, differenceInDays, now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { houseRecipients, networkActors } from './job-actor';
import { notify } from './notifications';

/**
 * Сроки, за которыми следит расписание (docs/04-MODULES/01-onboarding.md,
 * «Уведомления»; docs/03-BUSINESS-RULES.md §2.3).
 *
 * Справка предупреждает за 30 и 7 дней и в день истечения; возврат
 * депозита — за 7, 3 и 1 день до крайнего срока и один раз при просрочке.
 * Санкций ни там, ни там нет: система напоминает, решает человек.
 */
export const DOCUMENTS_EXPIRY_JOB = 'documents-expiry';
export const DEPOSIT_REFUND_WATCH_JOB = 'deposit-refund-watch';

/** За сколько дней предупреждать о сроке справки. Ноль — день истечения. */
export const DOCUMENT_WARNING_DAYS = [30, 7, 0] as const;

/** За сколько дней предупреждать о крайнем сроке возврата депозита. */
export const REFUND_WARNING_DAYS = [7, 3, 1] as const;

/** Крайний срок возврата — 30 дней от расторжения (§2.3 п.4). */
export const REFUND_DEADLINE_DAYS = 30;

export interface ExpiryDeps {
  executor?: Executor;
  instant?: Date;
}

export interface ExpiryResult {
  date: BusinessDate;
  notified: number;
  skipped: boolean;
}

export async function watchDocumentExpiry(deps: ExpiryDeps = {}): Promise<ExpiryResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  const date = todayInAlmaty(instant);
  const log = logger.child({ job: DOCUMENTS_EXPIRY_JOB, date });

  const run = await claimJobRun(DOCUMENTS_EXPIRY_JOB, date, executor);

  if (run === null) {
    log.info('сроки за этот день уже проверены');

    return { date, notified: 0, skipped: true };
  }

  // Ключ — строка даты из базы: `valid_until` там тип `date`, без времени.
  const deadlines = new Map<string, number>(
    DOCUMENT_WARNING_DAYS.map((days) => [addDays(date, days), days]),
  );

  let notified = 0;

  try {
    for (const actor of await networkActors(DOCUMENTS_EXPIRY_JOB, executor)) {
      /*
       * Название типа справки само хранится на трёх языках: в уведомление
       * оно идёт как локализованное значение, а не как одна строка.
       */
      const types = new Map(
        (await listDocumentTypes(actor.context, { includeArchived: true }, executor)).map(
          (type) => [type.id, type.nameI18n as Partial<Record<Locale, string>>],
        ),
      );
      const documents = await listDocuments(actor.context, { status: 'approved' }, executor);
      const residencies = new Map(
        (await listResidencies(actor.context, {}, executor)).map((item) => [item.id, item]),
      );

      for (const document of documents) {
        const validUntil = document.validUntil;
        const days = validUntil === null ? undefined : deadlines.get(validUntil);

        if (validUntil === null || days === undefined) {
          continue;
        }

        const residency = residencies.get(document.residencyId);

        if (residency === undefined) {
          continue;
        }

        const texts = await notificationTexts(
          days === 0 ? 'documentExpiresToday' : 'documentExpiring',
          { document: types.get(document.documentTypeId) ?? {}, date: validUntil },
        );

        // Жилец и тот, кто ведёт его дом: справку продлевает он, а следит — дом.
        const recipients = [
          residency.userId,
          ...(await houseRecipients(actor, residency.houseId, executor)),
        ];

        for (const userId of new Set(recipients)) {
          await notify(
            actor.context,
            {
              userId,
              type: 'document.expiring',
              title: texts.title,
              body: texts.body,
              payload: { documentId: document.id, validUntil, days },
            },
            executor,
          );
          notified += 1;
        }
      }
    }
  } catch (error) {
    await finishJobRun(run.id, 'failed', { error: String(error) }, executor);
    throw error;
  }

  await finishJobRun(run.id, 'done', { notified }, executor);
  log.info({ notified }, 'предупреждения о сроках справок разосланы');

  return { date, notified, skipped: false };
}

/**
 * Обратный отсчёт по возврату депозита.
 *
 * Просрочка сообщается один раз — в первый день после срока. Ежедневное
 * «просрочено» превратилось бы в шум, который перестают читать, а долг
 * при этом виден на экране суперадмина постоянно.
 */
export async function watchDepositRefunds(deps: ExpiryDeps = {}): Promise<ExpiryResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  const date = todayInAlmaty(instant);
  const log = logger.child({ job: DEPOSIT_REFUND_WATCH_JOB, date });

  const run = await claimJobRun(DEPOSIT_REFUND_WATCH_JOB, date, executor);

  if (run === null) {
    log.info('отсчёт за этот день уже проверен');

    return { date, notified: 0, skipped: true };
  }

  let notified = 0;

  try {
    for (const actor of await networkActors(DEPOSIT_REFUND_WATCH_JOB, executor)) {
      const houses = new Map(
        (await listHouses(actor.context, { includeArchived: true }, executor)).map((house) => [
          house.id,
          house.name,
        ]),
      );
      const residencies = await listResidencies(actor.context, { status: 'terminating' }, executor);

      for (const residency of residencies) {
        if (residency.terminationRequestedAt === null) {
          continue;
        }

        const deadline = addDays(
          todayInAlmaty(residency.terminationRequestedAt),
          REFUND_DEADLINE_DAYS,
        );
        const daysLeft = differenceInDays(date, deadline);

        const warn = (REFUND_WARNING_DAYS as readonly number[]).includes(daysLeft);
        const overdue = daysLeft === -1;

        if (!warn && !overdue) {
          continue;
        }

        const texts = await notificationTexts(overdue ? 'depositOverdue' : 'depositDeadline', {
          days: daysLeft,
          date: deadline,
          house: houses.get(residency.houseId) ?? '',
        });

        // Возврат депозита — дело сети: деньги отдаёт суперадмин, а не дом.
        await notify(
          actor.context,
          {
            userId: actor.context.userId,
            type: 'deposit.refund',
            title: texts.title,
            body: texts.body,
            payload: { residencyId: residency.id, deadline, daysLeft },
          },
          executor,
        );
        notified += 1;
      }
    }
  } catch (error) {
    await finishJobRun(run.id, 'failed', { error: String(error) }, executor);
    throw error;
  }

  await finishJobRun(run.id, 'done', { notified }, executor);
  log.info({ notified }, 'обратный отсчёт по депозитам разослан');

  return { date, notified, skipped: false };
}
