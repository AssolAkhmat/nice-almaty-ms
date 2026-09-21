import { and, asc, eq, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { closedPeriodLiteral, periodLiteral, type Period } from '../period';
import { areas, beds, temporaryResidents, type TemporaryResident } from '../schema';

/**
 * Временные жильцы (T11.3, указание владельца 21 сентября 2026).
 *
 * Это не пользователи: входа, профиля и денег у них нет. Репозиторий отдаёт
 * ровно то, что нужно ротациям, — кто стоит на месте в такой-то день и какого
 * он пола, — плюс перечень для экрана «Схема мест».
 *
 * Пересечения периодов на месте запрещены базой: ограничение исключения
 * и два триггера против настоящих проживаний (миграция 0027). Здесь их
 * проверки нет намеренно — она защищала бы только этот путь.
 */
function houseScope(context: AccessContext) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return sql`true`;
  }

  return visible.length === 0 ? sql`false` : sql`${temporaryResidents.houseId} in ${visible}`;
}

export interface TemporaryResidentRow extends TemporaryResident {
  bedLabel: string;
  areaId: string;
  areaName: string;
}

export interface TemporaryFilter {
  houseId: string;
  /** Только те, чей период накрывает эту дату. Пусто — все. */
  on?: BusinessDate;
}

export async function listTemporaryResidents(
  context: AccessContext,
  filter: TemporaryFilter,
  executor: Executor = getDb(),
): Promise<TemporaryResidentRow[]> {
  assertHouseVisible(context, filter.houseId);

  const conditions = [
    eq(temporaryResidents.orgId, context.orgId),
    eq(temporaryResidents.houseId, filter.houseId),
    houseScope(context),
  ];

  if (filter.on !== undefined) {
    conditions.push(sql`${temporaryResidents.period} @> ${filter.on}::date`);
  }

  const rows = await executor
    .select({
      temporary: temporaryResidents,
      bedLabel: beds.label,
      areaId: beds.areaId,
      areaName: areas.name,
    })
    .from(temporaryResidents)
    .innerJoin(beds, eq(beds.id, temporaryResidents.bedId))
    .innerJoin(areas, eq(areas.id, beds.areaId))
    .where(and(...conditions))
    .orderBy(
      asc(areas.sortOrder),
      asc(beds.label),
      asc(temporaryResidents.name),
      asc(temporaryResidents.id),
    );

  return rows.map((row) => ({
    ...row.temporary,
    bedLabel: row.bedLabel,
    areaId: row.areaId,
    areaName: row.areaName,
  }));
}

export async function requireTemporaryResident(
  context: AccessContext,
  id: string,
  executor: Executor = getDb(),
): Promise<TemporaryResident> {
  const [row] = await executor
    .select()
    .from(temporaryResidents)
    .where(
      and(
        eq(temporaryResidents.id, id),
        eq(temporaryResidents.orgId, context.orgId),
        houseScope(context),
      ),
    )
    .limit(1);

  if (row === undefined) {
    // Чужой дом неотличим от несуществующего (P1-1).
    throw new NotFoundError('Временный жилец не найден');
  }

  return row;
}

export interface CreateTemporaryInput {
  houseId: string;
  bedId: string;
  name: string;
  sex: 'male' | 'female';
  period: Period;
  note?: string | null;
  createdBy?: string | null;
}

export async function createTemporaryResident(
  context: AccessContext,
  input: CreateTemporaryInput,
  executor: Executor = getDb(),
): Promise<TemporaryResident> {
  assertHouseVisible(context, input.houseId);

  const [row] = await executor
    .insert(temporaryResidents)
    .values({
      orgId: context.orgId,
      houseId: input.houseId,
      bedId: input.bedId,
      name: input.name,
      sex: input.sex,
      period: periodLiteral(input.period),
      note: input.note ?? null,
      createdBy: input.createdBy ?? context.userId,
      updatedBy: input.createdBy ?? context.userId,
    })
    .returning();

  if (row === undefined) {
    throw new Error('Временный жилец не создан');
  }

  return row;
}

export interface UpdateTemporaryInput {
  name?: string;
  sex?: 'male' | 'female';
  period?: Period;
  note?: string | null;
}

export async function updateTemporaryResident(
  context: AccessContext,
  id: string,
  patch: UpdateTemporaryInput,
  executor: Executor = getDb(),
): Promise<TemporaryResident> {
  await requireTemporaryResident(context, id, executor);

  const [row] = await executor
    .update(temporaryResidents)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.sex === undefined ? {} : { sex: patch.sex }),
      ...(patch.period === undefined ? {} : { period: periodLiteral(patch.period) }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
      updatedBy: context.userId,
      updatedAt: now(),
    })
    .where(eq(temporaryResidents.id, id))
    .returning();

  if (row === undefined) {
    throw new NotFoundError('Временный жилец не найден');
  }

  return row;
}

export async function deleteTemporaryResident(
  context: AccessContext,
  id: string,
  executor: Executor = getDb(),
): Promise<void> {
  await requireTemporaryResident(context, id, executor);

  await executor.delete(temporaryResidents).where(eq(temporaryResidents.id, id));
}

/**
 * Кто из временных стоит на местах дома в этот день.
 *
 * Тот же вид, что у `listBedOccupantsOn` для настоящих жильцов: генератору
 * ротаций нужна пара «место — исполнитель», и разницу между ними он узнаёт
 * по тому, из какого перечня пришёл идентификатор.
 */
export async function listTemporaryBedOccupantsOn(
  context: AccessContext,
  houseId: string,
  date: BusinessDate,
  executor: Executor = getDb(),
): Promise<{ bedId: string; temporaryResidentId: string; name: string }[]> {
  assertHouseVisible(context, houseId);

  const rows = await executor
    .select({
      bedId: temporaryResidents.bedId,
      temporaryResidentId: temporaryResidents.id,
      name: temporaryResidents.name,
    })
    .from(temporaryResidents)
    .where(
      and(
        eq(temporaryResidents.orgId, context.orgId),
        eq(temporaryResidents.houseId, houseId),
        houseScope(context),
        sql`${temporaryResidents.period} @> ${date}::date`,
      ),
    );

  return rows;
}

/**
 * Временные жильцы дома для расчёта допуска.
 *
 * Состав настоящих жильцов собирается по «текущему» назначению места
 * (`upper_inf(period)`), а у временного период всегда конечен — таким
 * запросом он не нашёлся бы никогда. Поэтому перечень свой: берутся все,
 * кто ещё не съехал, вместе с зоной своего места.
 */
export async function listTemporaryEligibilityMembers(
  context: AccessContext,
  houseId: string,
  from: BusinessDate,
  executor: Executor = getDb(),
): Promise<{ temporaryResidentId: string; sex: 'male' | 'female'; areaId: string }[]> {
  assertHouseVisible(context, houseId);

  const rows = await executor
    .select({
      temporaryResidentId: temporaryResidents.id,
      sex: temporaryResidents.sex,
      areaId: beds.areaId,
    })
    .from(temporaryResidents)
    .innerJoin(beds, eq(beds.id, temporaryResidents.bedId))
    .where(
      and(
        eq(temporaryResidents.orgId, context.orgId),
        eq(temporaryResidents.houseId, houseId),
        houseScope(context),
        sql`upper(${temporaryResidents.period}) is null or upper(${temporaryResidents.period}) > ${from}::date`,
      ),
    );

  return rows;
}

/**
 * Снять временных жильцов с места начиная с даты.
 *
 * Зовётся заселением настоящего жильца в той же транзакции: место не может
 * быть одновременно за временным и за настоящим, и триггер базы это
 * подтвердит. Период, начавшийся раньше, обрезается — прошлые занятия
 * остаются с именем временного; ещё не начавшийся удаляется целиком.
 */
export async function releaseTemporaryOnBed(
  context: AccessContext,
  bedId: string,
  from: BusinessDate,
  executor: Executor = getDb(),
): Promise<TemporaryResident[]> {
  const overlapping = await executor
    .select()
    .from(temporaryResidents)
    .where(
      and(
        eq(temporaryResidents.orgId, context.orgId),
        eq(temporaryResidents.bedId, bedId),
        houseScope(context),
        sql`${temporaryResidents.period} && daterange(${from}::date, null)`,
      ),
    );

  const released: TemporaryResident[] = [];

  for (const row of overlapping) {
    const startsAt = row.period.slice(1, row.period.indexOf(',')) as BusinessDate;

    if (startsAt >= from) {
      await executor.delete(temporaryResidents).where(eq(temporaryResidents.id, row.id));
      released.push(row);
      continue;
    }

    const [updated] = await executor
      .update(temporaryResidents)
      .set({
        period: closedPeriodLiteral(startsAt, from),
        updatedBy: context.userId,
        updatedAt: now(),
      })
      .where(eq(temporaryResidents.id, row.id))
      .returning();

    released.push(updated ?? row);
  }

  return released;
}
