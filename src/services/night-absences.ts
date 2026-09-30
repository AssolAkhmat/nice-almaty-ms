import { getDb, type Executor } from '@/db/client';
import { listHouses } from '@/db/repositories/houses';
import { claimJobRun, finishJobRun } from '@/db/repositories/job-runs';
import { listAbsences } from '@/db/repositories/rating';
import { listProfileBirthDates } from '@/db/repositories/resident-profiles';
import { notificationLines, notificationTexts } from '@/lib/i18n/notification-texts';
import { logger } from '@/lib/logger';
import { addDays, compareBusinessDates, now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { houseRecipients, networkActors } from './job-actor';
import { notify } from './notifications';
import { optionLabel, personLabels } from './person-labels';

import type { UserActor } from './users';

/**
 * Ночная сводка заявленных отсутствий (решение владельца, 30 сентября 2026).
 *
 * До этого дня в 23:05 уходил список тех, кто **не** подавал уведомления.
 * В ночь на 27 сентября он назвал двенадцать человек «не подали уведомление
 * к отбою»: ни один из них ничего не заявлял и не нарушал — список строился
 * как «весь состав дома минус заявившиеся», то есть в него попадал каждый,
 * кто просто был дома.
 *
 * Причина была не в пороге и не в выборке, а в самом требовании: события
 * возврата в системе нет, отметки присутствия нет, и сказать «не вернулся»
 * системе нечем. Требование признано ошибочным и заменено на обратную
 * выборку: сводка сообщает только то, что в системе есть, — кто **заявился**.
 *
 * Две секции (обе — про заявления, не про выводы):
 *
 * 1. заявленные отсутствия на эту ночь: кто, до какой даты, причина;
 *    несовершеннолетние помечены и идут первыми;
 * 2. заявленные отсутствия с истёкшим сроком, по которым нового уведомления
 *    нет.
 *
 * Обе пусты — уведомление не уходит вовсе. Текст не делает выводов
 * «не вернулся» и «нарушил»: он перечисляет заявления.
 *
 * Основание — Приложение №1 к Договору, подраздел 2.2: жилец обязан уведомлять
 * администратора об отсутствии с 23:00 до 07:00, а несовершеннолетний не вправе
 * находиться вне Объекта с 23:00 до 06:00. Отметку присутствия не вводим.
 */
export const NIGHT_ABSENCES_JOB = 'night-absences';

/**
 * Насколько назад смотрит вторая секция.
 *
 * Требование говорит «с истёкшим сроком без нового уведомления» и окна
 * не называет. Без окна запись держалась бы в сводке вечно: событие возврата
 * закрыть её не может — его в системе нет. Вечная строка и есть тот самый
 * шум, из-за которого прежняя рассылка обесценила канал, поэтому окно
 * консервативное: две недели. Решение записано строкой `[ОТКРЫТО]`
 * в `docs/08-DECISIONS.md`.
 */
export const EXPIRED_WINDOW_DAYS = 14;

export interface NightAbsencesDeps {
  executor?: Executor;
  instant?: Date;
}

export interface NightAbsencesResult {
  date: BusinessDate;
  /** Сколько домов получили сводку. Дом без заявлений её не получает. */
  houses: number;
  notified: number;
  skipped: boolean;
}

/** Строка сводки: человек, дата и причина — ровно то, что он заявил. */
interface NightRow {
  userId: string;
  name: string;
  until: BusinessDate;
  reason: string;
  minor: boolean;
}

/** Совершеннолетие на дату ночи: сравнение дат, без арифметики в годах. */
function isMinorOn(birthDate: string | undefined, date: BusinessDate): boolean {
  if (birthDate === undefined) {
    return false;
  }

  const [year, month, day] = birthDate.split('-');

  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }

  const eighteenth = `${String(Number(year) + 18)}-${month}-${day}` as BusinessDate;

  return compareBusinessDates(date, eighteenth) < 0;
}

/**
 * Заявления дома, относящиеся к этой ночи.
 *
 * Краткосрочное уведомление одобрения не требует (§9) и годится фактом
 * подачи; отъезд и болезнь берутся только одобренными — неодобренное
 * заявление ещё не заявление, о нём сводке говорить нечего.
 */
function coversNight(
  absence: { type: string; status: string; startDate: string; endDate: string | null },
  date: BusinessDate,
): boolean {
  if (absence.type === 'short') {
    return absence.startDate === date;
  }

  if (absence.status !== 'approved') {
    return false;
  }

  return absence.startDate <= date && (absence.endDate ?? absence.startDate) >= date;
}

async function nightSections(
  actor: UserActor,
  houseId: string,
  date: BusinessDate,
  executor: Executor,
): Promise<{ declared: NightRow[]; expired: NightRow[] }> {
  const absences = await listAbsences(actor.context, { houseId }, executor);

  const declaredRaw = absences.filter((absence) => coversNight(absence, date));
  const onNight = new Set(declaredRaw.map((absence) => absence.userId));

  const since = addDays(date, -EXPIRED_WINDOW_DAYS);

  /*
   * Истёкшие: срок закончился до этой ночи, нового заявления на неё нет.
   * Окно ограничивает давность, иначе строка жила бы в сводке вечно —
   * закрыть её возвратом система не может.
   */
  const expiredRaw = absences.filter((absence) => {
    if (absence.type === 'short' || absence.status !== 'approved' || absence.endDate === null) {
      return false;
    }

    const end = absence.endDate as BusinessDate;

    return (
      compareBusinessDates(end, date) < 0 &&
      compareBusinessDates(end, since) >= 0 &&
      !onNight.has(absence.userId)
    );
  });

  const userIds = [...new Set([...declaredRaw, ...expiredRaw].map((absence) => absence.userId))];

  const [labels, birthDates] = await Promise.all([
    personLabels(actor.context, userIds, executor),
    listProfileBirthDates(actor.context, userIds, executor),
  ]);

  /* Несовершеннолетние идут первыми: у них ночная норма строже (до 06:00). */
  const toRows = (
    rows: readonly { userId: string; startDate: string; endDate: string | null; reason: string }[],
  ): NightRow[] =>
    rows
      .map((absence) => ({
        userId: absence.userId,
        name: optionLabel(labels.get(absence.userId), absence.userId),
        until: (absence.endDate ?? absence.startDate) as BusinessDate,
        reason: absence.reason,
        minor: isMinorOn(birthDates.get(absence.userId), date),
      }))
      .sort((left, right) =>
        left.minor === right.minor
          ? left.name.localeCompare(right.name)
          : Number(right.minor) - Number(left.minor),
      );

  return { declared: toRows(declaredRaw), expired: toRows(expiredRaw) };
}

export async function sendNightAbsences(
  deps: NightAbsencesDeps = {},
): Promise<NightAbsencesResult> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  const date = todayInAlmaty(instant);
  const log = logger.child({ job: NIGHT_ABSENCES_JOB, date });

  const run = await claimJobRun(NIGHT_ABSENCES_JOB, date, executor);

  if (run === null) {
    log.info('сводка за эту ночь уже отправлена');

    return { date, houses: 0, notified: 0, skipped: true };
  }

  let houses = 0;
  let notified = 0;

  try {
    const actors = await networkActors(NIGHT_ABSENCES_JOB, executor);

    for (const actor of actors) {
      for (const house of await listHouses(actor.context, {}, executor)) {
        const { declared, expired } = await nightSections(actor, house.id, date, executor);

        /* Обе секции пусты — сводки нет. Сообщать нечего, и молчание честнее. */
        if (declared.length === 0 && expired.length === 0) {
          continue;
        }

        houses += 1;

        const [declaredList, expiredList] = await Promise.all([
          notificationLines(
            declared.map((row) => ({
              code: row.minor ? 'presenceNightRowMinor' : 'presenceNightRow',
              values: { name: row.name, until: row.until, reason: row.reason },
            })),
          ),
          notificationLines(
            expired.map((row) => ({
              code: row.minor ? 'presenceExpiredRowMinor' : 'presenceExpiredRow',
              values: { name: row.name, until: row.until, reason: row.reason },
            })),
          ),
        ]);

        const none = await notificationLines([{ code: 'presenceNone' }]);

        const texts = await notificationTexts('presenceNight', {
          date,
          declared: declared.length,
          expired: expired.length,
          declaredList: declared.length === 0 ? none : declaredList,
          expiredList: expired.length === 0 ? none : expiredList,
        });

        for (const userId of await houseRecipients(actor, house.id, executor)) {
          await notify(
            actor.context,
            {
              userId,
              type: 'presence.night',
              title: texts.title,
              body: texts.body,
              payload: {
                date,
                houseId: house.id,
                declared: declared.map((row) => ({
                  userId: row.userId,
                  until: row.until,
                  minor: row.minor,
                })),
                expired: expired.map((row) => ({
                  userId: row.userId,
                  until: row.until,
                  minor: row.minor,
                })),
              },
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

  await finishJobRun(run.id, 'done', { houses, notified }, executor);
  log.info({ houses, notified }, 'ночные сводки отсутствий разосланы');

  return { date, houses, notified, skipped: false };
}
