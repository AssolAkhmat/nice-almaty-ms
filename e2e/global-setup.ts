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
} as const;

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

  // Ссылки «кто сделал» обнуляются: сама операция к прогону отношения не имеет.
  await db
    .update(schema.ledgerEntries)
    .set({ createdBy: null })
    .where(inArray(schema.ledgerEntries.createdBy, ids));
  await db
    .update(schema.auditLog)
    .set({ actorUserId: null })
    .where(inArray(schema.auditLog.actorUserId, ids));

  await db.delete(schema.residencies).where(inArray(schema.residencies.userId, ids));
  await db.delete(schema.sessions).where(inArray(schema.sessions.userId, ids));
  await db.delete(schema.residentProfiles).where(inArray(schema.residentProfiles.userId, ids));
  await db.delete(schema.users).where(inArray(schema.users.id, ids));
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
 * Зоны, заведённые прогоном: настройкой ротаций («Зона e2e…») и приёмкой
 * фазы 2 («Комната приёмки-…»). Успешный прогон убирает свои зоны сам,
 * руками админа; упавший — оставляет, и настройка дома растёт от запуска
 * к запуску вместе со временем отрисовки. Полторы сотни комнат приёмки
 * уже замедляли экран настолько, что проверки не укладывались в ожидание.
 *
 * Места удаляются вместе с зоной: назначения к этому моменту сняты вместе
 * с учётными записями прогона.
 */
const RUN_CREATED_AREAS = ['Зона e2e%', 'Комната приёмки-%'] as const;

async function removeLeftoverAreas(db: ReturnType<typeof drizzle>): Promise<void> {
  const leftovers = await db
    .select({ id: schema.areas.id })
    .from(schema.areas)
    .where(or(...RUN_CREATED_AREAS.map((pattern) => like(schema.areas.name, pattern))));

  if (leftovers.length === 0) {
    return;
  }

  const ids = leftovers.map((row) => row.id);

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
export const ACCEPTANCE_HOUSES = [3, 4, 5] as const;

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
    await seedNetwork({
      executor: db as unknown as Executor,
      passwordFor: () => E2E_PASSWORD,
    });

    /*
     * Счётчики попыток входа обнуляются перед прогоном: окно длится
     * четверть часа и переживает предыдущий запуск, а тестов, которые
     * входят по несколько раз, в наборе много. Это фикстура прогона,
     * а не послабление защиты — правило и его окно остаются прежними.
     */
    await db.delete(schema.rateLimits);

    await removeLeftoverAccounts(db);
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
