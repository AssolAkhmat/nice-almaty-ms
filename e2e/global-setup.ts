import { fileURLToPath } from 'node:url';
import { inArray, like, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { dotEnvFallback } from '../scripts/read-dotenv';
import * as schema from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { adminPhone, houseSlug, seedNetwork, SUPERADMIN_PHONE } from '../src/db/seed';

import type { Executor } from '../src/db/client';

/**
 * Подготовка данных для e2e.
 *
 * Продуктовый сид выдаёт случайные пароли и не трогает уже заведённые
 * учётные записи — это правильно для настоящей установки, но тестам нужен
 * предсказуемый вход. Поэтому здесь пароли задаются явно: это фикстура,
 * а не поведение приложения.
 */
export const E2E_PASSWORD = 'e2e-parol-proverki';

export const E2E_ACCOUNTS = {
  superadmin: SUPERADMIN_PHONE,
  adminHouse1: adminPhone(1),
  adminHouse2: adminPhone(2),
  /*
   * Дома приёмки фазы 3 — по одному на ширину. Коммунальный период у дома
   * один на месяц: три копии приёмки в общем доме отбирали бы его друг
   * у друга, и побеждала бы та, что успела закрыть его первой.
   */
  adminHouse3: adminPhone(3),
  adminHouse4: adminPhone(4),
  adminHouse5: adminPhone(5),
  /*
   * Дома приёмки фазы 4 — тоже по одному на ширину. Ряд ротаций у дома
   * общий, и три копии приёмки в одном доме собирали бы его друг поверх
   * друга: побеждала бы та, что успела сохранить последней.
   */
  adminHouse6: adminPhone(6),
  adminHouse7: adminPhone(7),
  adminHouse8: adminPhone(8),
  /*
   * Дома приёмки фазы 6 — снова по одному на ширину: приёмка заводит ряд
   * ротаций и дёргает задание напоминаний, а задание идёт по всей сети
   * сразу. В общем доме три копии считали бы уведомления друг друга.
   */
  adminHouse9: adminPhone(9),
  adminHouse10: adminPhone(10),
  adminHouse11: adminPhone(11),
} as const;

/**
 * Секрет заданий планировщика в прогоне. Тот же, что передаёт
 * `playwright.config.ts` серверу: приёмка фазы 6 дёргает задание
 * тем же путём, каким его дёргает расписание.
 */
export const E2E_CRON_SECRET = 'e2e-cron-secret-16';

/**
 * Номера, которые заводит сам прогон: `+7708…` — приёмка фазы 1,
 * `+7707…` — приёмка фазы 2. Сид пользуется `+7701…` и не трогается.
 */
const RUN_CREATED_PHONES = ['+7708%', '+7707%'] as const;

/**
 * Учётные записи, оставшиеся от прошлых прогонов.
 *
 * Прогон их не убирал, и база росла от запуска к запуску: через несколько
 * сотен жильцов список пользователей и схема мест перестали укладываться
 * в ожидание, и приёмки фаз 1 и 2 начали падать на ровном месте, без единой
 * правки кода. Набор тестов, зелёный сегодня и красный завтра, хуже
 * отсутствующего, поэтому прогон начинается с уборки за собой.
 *
 * Порядок удаления идёт от зависимых записей к самой учётной записи.
 * Журнал аудита переживает её: действие остаётся, автор обезличивается —
 * иначе уборка стирала бы историю, которой этот прогон уже не касается.
 */
async function removeLeftoverAccounts(db: ReturnType<typeof drizzle>): Promise<void> {
  const leftovers = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(or(...RUN_CREATED_PHONES.map((pattern) => like(schema.users.phone, pattern))));

  if (leftovers.length === 0) {
    return;
  }

  const ids = leftovers.map((row) => row.id);

  const residencyIds = (
    await db
      .select({ id: schema.residencies.id })
      .from(schema.residencies)
      .where(inArray(schema.residencies.userId, ids))
  ).map((row) => row.id);

  const invoiceIds =
    residencyIds.length === 0
      ? []
      : (
          await db
            .select({ id: schema.invoices.id })
            .from(schema.invoices)
            .where(inArray(schema.invoices.residencyId, residencyIds))
        ).map((row) => row.id);

  if (invoiceIds.length > 0) {
    await db.delete(schema.payments).where(inArray(schema.payments.invoiceId, invoiceIds));
    // Доля коммуналки ссылается на строку счёта: связь снимается до удаления.
    await db
      .update(schema.utilityAllocations)
      .set({ invoiceLineId: null })
      .where(
        inArray(
          schema.utilityAllocations.invoiceLineId,
          db
            .select({ id: schema.invoiceLines.id })
            .from(schema.invoiceLines)
            .where(inArray(schema.invoiceLines.invoiceId, invoiceIds)),
        ),
      );
    await db.delete(schema.invoiceLines).where(inArray(schema.invoiceLines.invoiceId, invoiceIds));
  }

  if (residencyIds.length > 0) {
    // Договор и подпись — файлы, на которые ссылается само проживание.
    await db
      .update(schema.residencies)
      .set({ contractFileId: null, signatureFileId: null })
      .where(inArray(schema.residencies.id, residencyIds));

    await db
      .delete(schema.damageShares)
      .where(inArray(schema.damageShares.residencyId, residencyIds));
    await db
      .delete(schema.depositTransactions)
      .where(inArray(schema.depositTransactions.residencyId, residencyIds));
    await db.delete(schema.documents).where(inArray(schema.documents.residencyId, residencyIds));
    await db.delete(schema.files).where(inArray(schema.files.residencyId, residencyIds));
    await db.delete(schema.invoices).where(inArray(schema.invoices.residencyId, residencyIds));
    await db
      .delete(schema.bedAssignments)
      .where(inArray(schema.bedAssignments.residencyId, residencyIds));
  }

  await db.delete(schema.files).where(inArray(schema.files.uploadedBy, ids));
  await db.delete(schema.utilityAllocations).where(inArray(schema.utilityAllocations.userId, ids));

  /*
   * Ротации: долг принадлежит человеку и уходит вместе с ним, а назначение
   * принадлежит занятию — у него обезличивается исполнитель, как и автор
   * записи в журнале. Иначе внешние ключи не дадут удалить учётную запись.
   */
  await db.delete(schema.rotationDebts).where(inArray(schema.rotationDebts.userId, ids));
  await db
    .update(schema.rotationAssignments)
    .set({ userId: null, state: 'needs_reassignment' })
    .where(inArray(schema.rotationAssignments.userId, ids));
  await db
    .update(schema.rotationAssignments)
    .set({ confirmedBy: null })
    .where(inArray(schema.rotationAssignments.confirmedBy, ids));
  await db
    .update(schema.rotationAssignments)
    .set({ scoredBy: null })
    .where(inArray(schema.rotationAssignments.scoredBy, ids));
  await db
    .update(schema.rotationOccurrences)
    .set({ createdBy: null })
    .where(inArray(schema.rotationOccurrences.createdBy, ids));

  /*
   * Рейтинг прогона уходит вместе с человеком: события, состояния порогов,
   * штрафы и скидки принадлежат ему, а не дому. Штраф, оставшийся без
   * жильца, не даёт удалить учётную запись — прогон падал на этом.
   */
  await db.delete(schema.ratingEvents).where(inArray(schema.ratingEvents.userId, ids));
  await db
    .delete(schema.ratingThresholdStates)
    .where(inArray(schema.ratingThresholdStates.userId, ids));
  await db.delete(schema.discounts).where(inArray(schema.discounts.userId, ids));
  await db.delete(schema.fines).where(inArray(schema.fines.userId, ids));
  await db.delete(schema.absences).where(inArray(schema.absences.userId, ids));

  // Ссылки «кто сделал» обнуляются: сама операция к прогону отношения не имеет.
  await db
    .update(schema.ledgerEntries)
    .set({ createdBy: null })
    .where(inArray(schema.ledgerEntries.createdBy, ids));
  await db
    .update(schema.auditLog)
    .set({ actorUserId: null })
    .where(inArray(schema.auditLog.actorUserId, ids));
  await db
    .update(schema.fines)
    .set({ createdBy: null })
    .where(inArray(schema.fines.createdBy, ids));
  await db
    .update(schema.fines)
    .set({ cancelledBy: null })
    .where(inArray(schema.fines.cancelledBy, ids));
  await db
    .update(schema.discounts)
    .set({ approvedBy: null })
    .where(inArray(schema.discounts.approvedBy, ids));
  await db
    .update(schema.ratingEvents)
    .set({ createdBy: null })
    .where(inArray(schema.ratingEvents.createdBy, ids));
  await db
    .update(schema.absences)
    .set({ reviewedBy: null })
    .where(inArray(schema.absences.reviewedBy, ids));

  await db.delete(schema.residencies).where(inArray(schema.residencies.userId, ids));
  await db.delete(schema.sessions).where(inArray(schema.sessions.userId, ids));
  await db.delete(schema.residentProfiles).where(inArray(schema.residentProfiles.userId, ids));
  await db.delete(schema.users).where(inArray(schema.users.id, ids));
}

/**
 * Типы документов и счета, заведённые приёмкой фазы 8. Интерфейс их не удаляет —
 * там только архивация, — а копиться от прогона к прогону им нельзя: экраны
 * настроек росли бы бесконечно, как это уже случилось со списком аккаунтов
 * (I3, I5), и интеграционный тест скелета сети считал бы чужие строки.
 */
async function removeProbeSettings(db: ReturnType<typeof drizzle>): Promise<void> {
  await db.delete(schema.documentTypes).where(like(schema.documentTypes.code, 'probe\\_%'));

  const probeAccounts = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(like(schema.accounts.code, 'probe\\_%'));

  if (probeAccounts.length > 0) {
    const ids = probeAccounts.map((row) => row.id);

    await db.delete(schema.ledgerLines).where(inArray(schema.ledgerLines.accountId, ids));
    await db.delete(schema.accounts).where(inArray(schema.accounts.id, ids));
  }
}

/**
 * Группы допуска, заведённые прогоном. Интерфейс их не удаляет — в модуле 11
 * такого действия нет, — а копиться от запуска к запуску им нельзя: экран
 * настройки ротаций рос бы бесконечно, и приёмка однажды перестала бы
 * в него укладываться, как это уже случилось со списком аккаунтов (I3, I5).
 */
async function removeLeftoverEligibilityGroups(db: ReturnType<typeof drizzle>): Promise<void> {
  const leftovers = await db
    .select({ id: schema.eligibilityGroups.id })
    .from(schema.eligibilityGroups)
    .where(like(schema.eligibilityGroups.name, 'e2e %'));

  if (leftovers.length === 0) {
    return;
  }

  const ids = leftovers.map((row) => row.id);

  await db.delete(schema.areaEligibility).where(inArray(schema.areaEligibility.groupId, ids));
  await db.delete(schema.eligibilityGroups).where(inArray(schema.eligibilityGroups.id, ids));
}

/**
 * Зоны, заведённые прогоном: настройкой ротаций («Зона e2e…»),
 * настройкой дома («Комната e2e…») и приёмкой фазы 2 («Комната приёмки-…»). Успешный прогон убирает свои зоны сам,
 * руками админа; упавший — оставляет, и настройка дома растёт от запуска
 * к запуску вместе со временем отрисовки. Полторы сотни комнат приёмки
 * уже замедляли экран настолько, что проверки не укладывались в ожидание.
 *
 * Места удаляются вместе с зоной: назначения к этому моменту сняты вместе
 * с учётными записями прогона.
 */
const RUN_CREATED_AREAS = ['Зона e2e%', 'Комната e2e%', 'Комната приёмки-%'] as const;

async function removeLeftoverAreas(db: ReturnType<typeof drizzle>): Promise<void> {
  const leftovers = await db
    .select({ id: schema.areas.id })
    .from(schema.areas)
    .where(or(...RUN_CREATED_AREAS.map((pattern) => like(schema.areas.name, pattern))));

  if (leftovers.length === 0) {
    return;
  }

  const ids = leftovers.map((row) => row.id);

  /*
   * Ротации держат зону за чек-лист и за само занятие, а ряд — за место.
   * Сначала снимаются они, иначе внешние ключи не дадут убрать зону.
   */
  const occurrenceIds = (
    await db
      .select({ id: schema.rotationOccurrences.id })
      .from(schema.rotationOccurrences)
      .where(inArray(schema.rotationOccurrences.areaId, ids))
  ).map((row) => row.id);

  if (occurrenceIds.length > 0) {
    const assignmentIds = (
      await db
        .select({ id: schema.rotationAssignments.id })
        .from(schema.rotationAssignments)
        .where(inArray(schema.rotationAssignments.occurrenceId, occurrenceIds))
    ).map((row) => row.id);

    if (assignmentIds.length > 0) {
      await db
        .delete(schema.rotationDebts)
        .where(inArray(schema.rotationDebts.sourceAssignmentId, assignmentIds));
      await db
        .delete(schema.rotationAssignments)
        .where(inArray(schema.rotationAssignments.id, assignmentIds));
    }

    await db
      .delete(schema.rotationOccurrences)
      .where(inArray(schema.rotationOccurrences.id, occurrenceIds));
  }

  await db.delete(schema.rotationRowZones).where(inArray(schema.rotationRowZones.areaId, ids));

  const areaBedIds = (
    await db
      .select({ id: schema.beds.id })
      .from(schema.beds)
      .where(inArray(schema.beds.areaId, ids))
  ).map((row) => row.id);

  if (areaBedIds.length > 0) {
    await db
      .delete(schema.rotationRowSlots)
      .where(inArray(schema.rotationRowSlots.bedId, areaBedIds));
  }

  await db.delete(schema.areaEligibility).where(inArray(schema.areaEligibility.areaId, ids));
  await db.delete(schema.areaChecklists).where(inArray(schema.areaChecklists.areaId, ids));

  const bedIds = (
    await db
      .select({ id: schema.beds.id })
      .from(schema.beds)
      .where(inArray(schema.beds.areaId, ids))
  ).map((row) => row.id);

  if (bedIds.length > 0) {
    // Зона с занятым местом остаётся: удалять её означало бы стереть
    // проживание, к прогону отношения не имеющее.
    const assigned = (
      await db
        .select({ bedId: schema.bedAssignments.bedId })
        .from(schema.bedAssignments)
        .where(inArray(schema.bedAssignments.bedId, bedIds))
    ).map((row) => row.bedId);

    const free = bedIds.filter((bedId) => !assigned.includes(bedId));
    const busyAreas = new Set(
      assigned.length === 0
        ? []
        : (
            await db
              .select({ areaId: schema.beds.areaId })
              .from(schema.beds)
              .where(inArray(schema.beds.id, assigned))
          ).map((row) => row.areaId),
    );

    if (free.length > 0) {
      await db.delete(schema.beds).where(inArray(schema.beds.id, free));
    }

    const removable = ids.filter((areaId) => !busyAreas.has(areaId));

    if (removable.length > 0) {
      await db.delete(schema.areas).where(inArray(schema.areas.id, removable));
    }

    return;
  }

  await db.delete(schema.areas).where(inArray(schema.areas.id, ids));
}

/**
 * Дома приёмки фазы 3 отданы ей целиком: коммунальный период дома заводится
 * один на месяц, и закрытый прошлым прогоном он не даёт следующему дойти
 * до строки. Убирается всё, что прогон в этих домах заводит: периоды
 * с их строками и снимками распределения и ущербы с долями.
 */
export const ACCEPTANCE_HOUSES = [3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

/**
 * Задания фазы 6 и разосланные ими уведомления.
 *
 * Прогон дёргает `rotations-remind` напрямую, а задание идемпотентно
 * по паре «день и слот»: отработанный прошлым запуском слот не разослал
 * бы ничего следующему, и приёмка проходила бы только один раз в сутки.
 * Это фикстура прогона, а не послабление правила: сама идемпотентность
 * проверяется внутри приёмки повторным вызовом.
 */
const PHASE_SIX_JOBS = [
  'rotations-remind',
  'curfew-check',
  'utilities-remind',
  'schedule-remind',
  'documents-expiry',
  'deposit-refund-watch',
] as const;

async function resetPhaseSixJobs(db: ReturnType<typeof drizzle>): Promise<void> {
  await db.delete(schema.jobRuns).where(inArray(schema.jobRuns.job, [...PHASE_SIX_JOBS]));

  const notificationIds = (
    await db.select({ id: schema.notifications.id }).from(schema.notifications)
  ).map((row) => row.id);

  if (notificationIds.length === 0) {
    return;
  }

  await db
    .delete(schema.notificationOutbox)
    .where(inArray(schema.notificationOutbox.notificationId, notificationIds));
  await db.delete(schema.notifications).where(inArray(schema.notifications.id, notificationIds));
  // Подписки на push тоже держат пользователя: их прогон не заводит, но мог бы.
  await db.delete(schema.pushSubscriptions);
}

/**
 * Жильцы сида (`+7702…`) и всё, что за ними тянется.
 *
 * Прогон вызывает сид без наполнения, но живая база могла увидеть и полный
 * `pnpm db:seed`: тогда в домах приёмок появляются чужие жильцы, и доля
 * коммуналки делится не на тех. Приёмка обязана считать только своих.
 */
async function removeSeededResidents(db: ReturnType<typeof drizzle>): Promise<void> {
  const seeded = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(like(schema.users.phone, '+7702%'));

  if (seeded.length === 0) {
    return;
  }

  const userIds = seeded.map((row) => row.id);

  const residencyIds = (
    await db
      .select({ id: schema.residencies.id })
      .from(schema.residencies)
      .where(inArray(schema.residencies.userId, userIds))
  ).map((row) => row.id);

  if (residencyIds.length > 0) {
    await db
      .delete(schema.bedAssignments)
      .where(inArray(schema.bedAssignments.residencyId, residencyIds));
    await db.delete(schema.residencies).where(inArray(schema.residencies.id, residencyIds));
  }

  await db
    .delete(schema.rotationAssignments)
    .where(inArray(schema.rotationAssignments.userId, userIds));
  await db.delete(schema.rotationDebts).where(inArray(schema.rotationDebts.userId, userIds));
  await db
    .delete(schema.utilityAllocations)
    .where(inArray(schema.utilityAllocations.userId, userIds));
  await db.delete(schema.absences).where(inArray(schema.absences.userId, userIds));
  await db.delete(schema.ratingEvents).where(inArray(schema.ratingEvents.userId, userIds));
  await db
    .delete(schema.ratingThresholdStates)
    .where(inArray(schema.ratingThresholdStates.userId, userIds));
  await db.delete(schema.discounts).where(inArray(schema.discounts.userId, userIds));
  await db.delete(schema.fines).where(inArray(schema.fines.userId, userIds));
  await db.delete(schema.residentProfiles).where(inArray(schema.residentProfiles.userId, userIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
}

async function removeAcceptanceHouseData(db: ReturnType<typeof drizzle>): Promise<void> {
  const houses = await db
    .select({ id: schema.houses.id })
    .from(schema.houses)
    .where(inArray(schema.houses.slug, ACCEPTANCE_HOUSES.map(houseSlug)));

  if (houses.length === 0) {
    return;
  }

  const houseIds = houses.map((row) => row.id);

  const periodIds = (
    await db
      .select({ id: schema.utilityPeriods.id })
      .from(schema.utilityPeriods)
      .where(inArray(schema.utilityPeriods.houseId, houseIds))
  ).map((row) => row.id);

  if (periodIds.length > 0) {
    await db
      .delete(schema.utilityAllocations)
      .where(inArray(schema.utilityAllocations.periodId, periodIds));
    await db.delete(schema.utilityLines).where(inArray(schema.utilityLines.periodId, periodIds));
    await db.delete(schema.utilityPeriods).where(inArray(schema.utilityPeriods.id, periodIds));
  }

  /*
   * Ротации приёмки фазы 4: ряд у дома один, и оставленный прошлым прогоном
   * он не даёт следующему собрать свой. Убирается всё дерево — назначения,
   * занятия, слоты, зоны рядов, сами ряды, допуски и чек-листы.
   */
  const rowIds = (
    await db
      .select({ id: schema.rotationRows.id })
      .from(schema.rotationRows)
      .where(inArray(schema.rotationRows.houseId, houseIds))
  ).map((row) => row.id);

  const occurrenceIds = (
    await db
      .select({ id: schema.rotationOccurrences.id })
      .from(schema.rotationOccurrences)
      .where(inArray(schema.rotationOccurrences.houseId, houseIds))
  ).map((row) => row.id);

  if (occurrenceIds.length > 0) {
    const assignmentIds = (
      await db
        .select({ id: schema.rotationAssignments.id })
        .from(schema.rotationAssignments)
        .where(inArray(schema.rotationAssignments.occurrenceId, occurrenceIds))
    ).map((row) => row.id);

    if (assignmentIds.length > 0) {
      // Долг ссылается на назначение: связь снимается до удаления.
      await db
        .delete(schema.rotationDebts)
        .where(inArray(schema.rotationDebts.sourceAssignmentId, assignmentIds));
      await db
        .delete(schema.rotationAssignments)
        .where(inArray(schema.rotationAssignments.id, assignmentIds));
    }

    await db
      .delete(schema.rotationOccurrences)
      .where(inArray(schema.rotationOccurrences.id, occurrenceIds));
  }

  if (rowIds.length > 0) {
    await db.delete(schema.rotationRowSlots).where(inArray(schema.rotationRowSlots.rowId, rowIds));
    await db.delete(schema.rotationRowZones).where(inArray(schema.rotationRowZones.rowId, rowIds));
    await db.delete(schema.rotationRows).where(inArray(schema.rotationRows.id, rowIds));
  }

  const areaIds = (
    await db
      .select({ id: schema.areas.id })
      .from(schema.areas)
      .where(inArray(schema.areas.houseId, houseIds))
  ).map((row) => row.id);

  if (areaIds.length > 0) {
    await db.delete(schema.areaEligibility).where(inArray(schema.areaEligibility.areaId, areaIds));
    await db.delete(schema.areaChecklists).where(inArray(schema.areaChecklists.areaId, areaIds));
  }

  await db
    .delete(schema.eligibilityGroups)
    .where(inArray(schema.eligibilityGroups.houseId, houseIds));

  /*
   * Переопределения правил рейтинга приёмки: оставленные прошлым прогоном,
   * они сместили бы дельты следующего — тот правит те же коды.
   */
  await db.delete(schema.ratingRules).where(inArray(schema.ratingRules.houseId, houseIds));

  const damageIds = (
    await db
      .select({ id: schema.damages.id })
      .from(schema.damages)
      .where(inArray(schema.damages.houseId, houseIds))
  ).map((row) => row.id);

  if (damageIds.length > 0) {
    await db.delete(schema.damageShares).where(inArray(schema.damageShares.damageId, damageIds));
    await db.delete(schema.damages).where(inArray(schema.damages.id, damageIds));
  }
}

export default async function globalSetup(): Promise<void> {
  const fileEnv = dotEnvFallback(fileURLToPath(new URL('../.env', import.meta.url)));

  const url =
    process.env.E2E_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    fileEnv.E2E_DATABASE_URL ??
    fileEnv.TEST_DATABASE_URL ??
    'postgres://nice:nice@127.0.0.1:5432/nice_almaty';

  const client = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  const db = drizzle(client, { schema });

  try {
    /*
     * Каркас без наполнения: приёмки заводят своих жильцов и свои ряды,
     * а сидовые мешали бы им — счётчики и списки перестали бы сходиться.
     */
    await seedNetwork({
      executor: db as unknown as Executor,
      passwordFor: () => E2E_PASSWORD,
      withContent: false,
      // Дома с третьего по одиннадцатый отданы приёмкам, по одному на ширину.
      houses: 11,
    });

    /*
     * Счётчики попыток входа обнуляются перед прогоном: окно длится
     * четверть часа и переживает предыдущий запуск, а тестов, которые
     * входят по несколько раз, в наборе много. Это фикстура прогона,
     * а не послабление защиты — правило и его окно остаются прежними.
     */
    await db.delete(schema.rateLimits);

    /*
     * Уведомления снимаются первыми: они ссылаются на пользователей,
     * а прошлые учётные записи прогона удаляются следующим шагом.
     */
    await resetPhaseSixJobs(db);
    await removeSeededResidents(db);
    await removeLeftoverAccounts(db);
    await removeProbeSettings(db);
    await removeLeftoverEligibilityGroups(db);
    await removeLeftoverAreas(db);
    await removeAcceptanceHouseData(db);

    const phones = Object.values(E2E_ACCOUNTS);

    await db
      .update(schema.users)
      .set({
        passwordHash: await hashPassword(E2E_PASSWORD),
        // Тестам нужен готовый к работе аккаунт: обязательную смену снимаем.
        mustChangePassword: false,
        passwordResetAllowedUntil: null,
      })
      .where(inArray(schema.users.phone, [...phones]));
  } finally {
    await client.end();
  }
}
