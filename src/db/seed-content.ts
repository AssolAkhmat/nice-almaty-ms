import { and, eq } from 'drizzle-orm';

import { hashPassword } from '@/lib/password';
import {
  addDays,
  endOfMonth,
  startOfDayUtc,
  startOfMonth,
  toAlmatyParts,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import {
  areaChecklists,
  areas,
  bedAssignments,
  beds,
  residencies,
  residentProfiles,
  rotationDayNormZones,
  rotationDayNorms,
  rotationRowRosterSlots,
  rotationRowRosters,
  rotationRows,
  users,
} from './schema';

import type { Executor } from './client';

/**
 * Наполнение сида (docs/07-ROADMAP.md, «Сид-данные»).
 *
 * Пять домов из одиннадцати наполняются целиком: комнаты и места с ценами,
 * общие зоны с чек-листами, жильцы на большинство мест, ряды ротаций
 * на вторник, четверг и воскресенье и расписание на текущий месяц.
 * Остальные шесть остаются каркасом: они отданы приёмкам, и жильцы
 * в них мешали бы прогонам (P7-13).
 *
 * Истории нет намеренно: рейтинги стартовые, счетов и ущербов не заведено.
 * Система начинается с чистого учебного года, а не с чужого прошлого.
 */
export const FURNISHED_HOUSES = 5;

/** Комнат в доме и мест в комнате: небольшое общежитие, как в жизни. */
export const ROOMS_PER_HOUSE = 4;
export const BEDS_PER_ROOM = 3;

/** Цена места: нижний ярус дороже верхнего, разница в пять тысяч. */
const LOWER_PRICE = 75_000;
const UPPER_PRICE = 70_000;

/** Сколько мест заселено: «большинство», но не все — свободные нужны боту. */
export const OCCUPANCY = 0.7;

const ZONES = [
  { name: 'Кухня', checklist: 'Уборка кухни', people: 2 },
  { name: 'Двор', checklist: 'Уборка двора', people: 1 },
  { name: 'Санузел', checklist: 'Уборка санузла', people: 1 },
  { name: 'Коридор', checklist: 'Уборка коридора', people: 1 },
];

/**
 * Вторник, четверг, воскресенье — дни ротаций из сид-данных роадмапа.
 * Нумерация приложения: 0 — воскресенье, 6 — суббота (`src/lib/time.ts`).
 */
const ROTATION_WEEKDAYS = [2, 4, 0] as const;

const FIRST_NAMES = ['Алишер', 'Данияр', 'Ерлан', 'Мадина', 'Айгерим', 'Тимур'];
const LAST_NAMES = ['Абдуллаев', 'Сериков', 'Нурланов', 'Жумабек', 'Оспанова', 'Калиев'];

function residentPhone(house: number, index: number): string {
  return `+7702${String(house).padStart(2, '0')}${String(index).padStart(5, '0')}`;
}

function nameOf(index: number): { first: string; last: string } {
  return {
    first: FIRST_NAMES[index % FIRST_NAMES.length] ?? 'Жилец',
    last: LAST_NAMES[index % LAST_NAMES.length] ?? 'Жилец',
  };
}

/** Ближайшая дата с нужным днём недели, начиная с первого числа месяца. */
function firstWeekdayOfMonth(month: BusinessDate, weekday: number): BusinessDate {
  for (let shift = 0; shift < 7; shift += 1) {
    const candidate = addDays(month, shift);
    const day = toAlmatyParts(startOfDayUtc(candidate)).weekday;

    if (day === weekday) {
      return candidate;
    }
  }

  return month;
}

async function ensureRooms(
  executor: Executor,
  houseId: string,
): Promise<{ areaId: string; bedIds: string[] }[]> {
  const rooms: { areaId: string; bedIds: string[] }[] = [];

  for (let number = 1; number <= ROOMS_PER_HOUSE; number += 1) {
    const name = `Комната ${number}`;

    const [existing] = await executor
      .select({ id: areas.id })
      .from(areas)
      .where(and(eq(areas.houseId, houseId), eq(areas.name, name)))
      .limit(1);

    const areaId =
      existing?.id ??
      (
        await executor
          .insert(areas)
          .values({ houseId, type: 'living', name, sortOrder: number })
          .returning()
      )[0]?.id ??
      '';

    const bedIds: string[] = [];

    for (let index = 1; index <= BEDS_PER_ROOM; index += 1) {
      const label = `${number}-${index}`;
      const tier = index === BEDS_PER_ROOM ? 'upper' : 'lower';

      const [bed] = await executor
        .select({ id: beds.id })
        .from(beds)
        .where(and(eq(beds.houseId, houseId), eq(beds.label, label)))
        .limit(1);

      if (bed !== undefined) {
        bedIds.push(bed.id);
        continue;
      }

      const [created] = await executor
        .insert(beds)
        .values({
          houseId,
          areaId,
          label,
          number: index,
          tier,
          defaultPrice: tier === 'lower' ? LOWER_PRICE : UPPER_PRICE,
        })
        .returning();

      if (created !== undefined) {
        bedIds.push(created.id);
      }
    }

    rooms.push({ areaId, bedIds });
  }

  return rooms;
}

async function ensureZones(
  executor: Executor,
  houseId: string,
): Promise<{ areaId: string; checklistId: string }[]> {
  const result: { areaId: string; checklistId: string }[] = [];

  for (const [index, zone] of ZONES.entries()) {
    const [existing] = await executor
      .select({ id: areas.id })
      .from(areas)
      .where(and(eq(areas.houseId, houseId), eq(areas.name, zone.name)))
      .limit(1);

    const areaId =
      existing?.id ??
      (
        await executor
          .insert(areas)
          .values({ houseId, type: 'common', name: zone.name, sortOrder: 100 + index })
          .returning()
      )[0]?.id ??
      '';

    const [checklist] = await executor
      .select({ id: areaChecklists.id })
      .from(areaChecklists)
      .where(and(eq(areaChecklists.areaId, areaId), eq(areaChecklists.type, 'regular')))
      .limit(1);

    const checklistId =
      checklist?.id ??
      (
        await executor
          .insert(areaChecklists)
          .values({
            areaId,
            type: 'regular',
            title: zone.checklist,
            peopleNeeded: zone.people,
            items: ['Подмести', 'Вымыть пол', 'Вынести мусор'],
          })
          .returning()
      )[0]?.id ??
      '';

    result.push({ areaId, checklistId });
  }

  return result;
}

async function ensureResidents(
  executor: Executor,
  orgId: string,
  houseId: string,
  houseNumber: number,
  rooms: { areaId: string; bedIds: string[] }[],
  passwordFor: (phone: string) => string,
  moveInDate: BusinessDate,
): Promise<number> {
  const allBeds = rooms.flatMap((room) => room.bedIds);
  const target = Math.floor(allBeds.length * OCCUPANCY);
  let seeded = 0;

  for (let index = 0; index < target; index += 1) {
    const phone = residentPhone(houseNumber, index + 1);
    const { first, last } = nameOf(index + houseNumber);

    const [existing] = await executor
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, phone))
      .limit(1);

    if (existing !== undefined) {
      continue;
    }

    const [user] = await executor
      .insert(users)
      .values({
        orgId,
        phone,
        passwordHash: await hashPassword(passwordFor(phone)),
        role: 'resident',
        mustChangePassword: true,
      })
      .returning();

    const userId = user?.id ?? '';

    await executor.insert(residentProfiles).values({
      userId,
      firstName: first,
      lastName: last,
      sex: index % 2 === 0 ? 'male' : 'female',
      university: 'КазНУ',
      course: (index % 4) + 1,
    });

    const [residency] = await executor
      .insert(residencies)
      .values({ orgId, userId, houseId, status: 'active', moveInDate })
      .returning();

    await executor.insert(bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId: allBeds[index] ?? '',
      price: index % BEDS_PER_ROOM === BEDS_PER_ROOM - 1 ? UPPER_PRICE : LOWER_PRICE,
      period: `[${moveInDate},)`,
    });

    seeded += 1;
  }

  return seeded;
}

async function ensureRows(
  executor: Executor,
  orgId: string,
  houseId: string,
  rooms: { areaId: string; bedIds: string[] }[],
  zones: { areaId: string; checklistId: string }[],
  month: BusinessDate,
): Promise<void> {
  const allBeds = rooms.flatMap((room) => room.bedIds);

  for (const [index, weekday] of ROTATION_WEEKDAYS.entries()) {
    const name = `Ряд ${index + 1}`;

    const [existing] = await executor
      .select({ id: rotationRows.id })
      .from(rotationRows)
      .where(and(eq(rotationRows.houseId, houseId), eq(rotationRows.name, name)))
      .limit(1);

    if (existing !== undefined) {
      continue;
    }

    const startDate = firstWeekdayOfMonth(month, weekday);

    const [row] = await executor
      .insert(rotationRows)
      .values({
        orgId,
        houseId,
        name,
        type: 'common',
        weekday,
        startDate,
        sortOrder: index,
        isActive: true,
      })
      .returning();

    const rowId = row?.id ?? '';

    // Состав и норма первой версией (фаза 10, §2.2, §2.3): генерация читает их.
    const [roster] = await executor
      .insert(rotationRowRosters)
      .values({ rowId, effectiveFrom: startDate })
      .returning();

    await executor.insert(rotationRowRosterSlots).values(
      allBeds.map((bedId, position) => ({
        rosterId: roster?.id ?? '',
        position,
        bedId,
      })),
    );

    const [norm] = await executor
      .insert(rotationDayNorms)
      .values({ rowId, effectiveFrom: startDate })
      .returning();

    await executor.insert(rotationDayNormZones).values(
      zones.map((zone, position) => ({
        normId: norm?.id ?? '',
        position,
        areaId: zone.areaId,
        checklistId: zone.checklistId,
        people: 1,
      })),
    );
  }
}

export interface ContentResult {
  /** Сколько жильцов завёл этот запуск: повторный не заводит никого. */
  residents: number;
  /** Месяц, на который рассчитано расписание. */
  month: BusinessDate;
  /** Конец месяца: до этой даты материализуются занятия. */
  until: BusinessDate;
}

/**
 * Наполняет первые пять домов. Идемпотентно: существующие комнаты, места,
 * зоны, ряды и жильцы не трогаются — повторный запуск сида не удваивает
 * ни общежитие, ни его расписание.
 */
export async function seedContent(
  executor: Executor,
  orgId: string,
  houseIds: readonly string[],
  passwordFor: (phone: string) => string,
): Promise<ContentResult> {
  const today = todayInAlmaty();
  const month = startOfMonth(today);
  const moveInDate = month;
  let residents = 0;

  for (let number = 1; number <= Math.min(FURNISHED_HOUSES, houseIds.length); number += 1) {
    const houseId = houseIds[number - 1] ?? '';

    const rooms = await ensureRooms(executor, houseId);
    const zones = await ensureZones(executor, houseId);

    residents += await ensureResidents(
      executor,
      orgId,
      houseId,
      number,
      rooms,
      passwordFor,
      moveInDate,
    );

    await ensureRows(executor, orgId, houseId, rooms, zones, month);
  }

  return { residents, month, until: endOfMonth(month) };
}
