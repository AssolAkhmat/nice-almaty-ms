import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  utilityAllocations,
  utilityLines,
  utilityPeriods,
  type NewUtilityAllocation,
  type NewUtilityLine,
  type NewUtilityPeriod,
  type UtilityAllocation,
  type UtilityLine,
  type UtilityPeriod,
} from '../schema';

/**
 * Коммунальные периоды, их строки и снимок распределения
 * (docs/03-BUSINESS-RULES.md §4, docs/04-MODULES/06-utilities.md).
 *
 * Период принадлежит дому, поэтому видимость идёт по дому: коммуналка
 * соседнего дома админу не показывается и по прямой ссылке.
 */
function periodScope(context: AccessContext) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return eq(utilityPeriods.orgId, context.orgId);
  }

  return visible.length === 0
    ? sql`false`
    : and(eq(utilityPeriods.orgId, context.orgId), inArray(utilityPeriods.houseId, [...visible]));
}

export async function listUtilityPeriods(
  context: AccessContext,
  filter: { houseId?: string; status?: UtilityPeriod['status'] } = {},
  executor: Executor = getDb(),
): Promise<UtilityPeriod[]> {
  const conditions = [periodScope(context)];

  if (filter.houseId !== undefined) {
    assertHouseVisible(context, filter.houseId);
    conditions.push(eq(utilityPeriods.houseId, filter.houseId));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(utilityPeriods.status, filter.status));
  }

  return executor
    .select()
    .from(utilityPeriods)
    .where(and(...conditions))
    .orderBy(desc(utilityPeriods.month));
}

export async function findUtilityPeriod(
  context: AccessContext,
  houseId: string,
  month: BusinessDate,
  executor: Executor = getDb(),
): Promise<UtilityPeriod | null> {
  assertHouseVisible(context, houseId);

  const [period] = await executor
    .select()
    .from(utilityPeriods)
    .where(
      and(
        periodScope(context),
        eq(utilityPeriods.houseId, houseId),
        eq(utilityPeriods.month, month),
      ),
    )
    .limit(1);

  return period ?? null;
}

export async function requireUtilityPeriod(
  context: AccessContext,
  periodId: string,
  executor: Executor = getDb(),
): Promise<UtilityPeriod> {
  const [period] = await executor
    .select()
    .from(utilityPeriods)
    .where(and(periodScope(context), eq(utilityPeriods.id, periodId)))
    .limit(1);

  if (period === undefined) {
    throw new NotFoundError('Период коммуналки не найден');
  }

  return period;
}

export async function createUtilityPeriod(
  context: AccessContext,
  input: Omit<NewUtilityPeriod, 'orgId'>,
  executor: Executor = getDb(),
): Promise<UtilityPeriod> {
  assertHouseVisible(context, input.houseId);

  const [period] = await executor
    .insert(utilityPeriods)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (period === undefined) {
    throw new Error('Период коммуналки не создан');
  }

  return period;
}

export async function updateUtilityPeriod(
  context: AccessContext,
  periodId: string,
  patch: Partial<Omit<NewUtilityPeriod, 'id' | 'orgId' | 'houseId'>>,
  executor: Executor = getDb(),
): Promise<UtilityPeriod | null> {
  const [period] = await executor
    .update(utilityPeriods)
    .set({ ...patch, updatedAt: now() })
    .where(and(periodScope(context), eq(utilityPeriods.id, periodId)))
    .returning();

  return period ?? null;
}

export async function listUtilityLines(
  periodId: string,
  executor: Executor = getDb(),
): Promise<UtilityLine[]> {
  return executor
    .select()
    .from(utilityLines)
    .where(eq(utilityLines.periodId, periodId))
    .orderBy(asc(utilityLines.createdAt));
}

export async function addUtilityLine(
  input: NewUtilityLine,
  executor: Executor = getDb(),
): Promise<UtilityLine> {
  const [line] = await executor.insert(utilityLines).values(input).returning();

  if (line === undefined) {
    throw new Error('Строка коммуналки не создана');
  }

  return line;
}

export async function findUtilityLine(
  lineId: string,
  executor: Executor = getDb(),
): Promise<UtilityLine | null> {
  const [line] = await executor
    .select()
    .from(utilityLines)
    .where(eq(utilityLines.id, lineId))
    .limit(1);

  return line ?? null;
}

export async function updateUtilityLine(
  lineId: string,
  patch: Partial<Omit<NewUtilityLine, 'id' | 'periodId'>>,
  executor: Executor = getDb(),
): Promise<UtilityLine | null> {
  const [line] = await executor
    .update(utilityLines)
    .set({ ...patch, updatedAt: now() })
    .where(eq(utilityLines.id, lineId))
    .returning();

  return line ?? null;
}

export async function deleteUtilityLine(
  lineId: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor.delete(utilityLines).where(eq(utilityLines.id, lineId));
}

export async function listUtilityAllocations(
  periodId: string,
  executor: Executor = getDb(),
): Promise<UtilityAllocation[]> {
  return executor
    .select()
    .from(utilityAllocations)
    .where(eq(utilityAllocations.periodId, periodId))
    .orderBy(asc(utilityAllocations.createdAt));
}

/**
 * Доля жильца за закрытый период — для строки месячного счёта (§3, §4).
 *
 * Открытый период доли не даёт: пока строки правятся, распределение
 * предварительное, и попасть в счёт оно не должно.
 */
export interface UtilityHistoryRow {
  periodId: string;
  month: string;
  participants: number;
  days: number;
  total: number;
}

/**
 * Сводка закрытых периодов дома (модуль 6, «Отчёты»). Считается по снимку
 * распределения: открытый период в отчёт не входит — его доли ещё меняются,
 * а отчёт о том, что может измениться, вводит в заблуждение.
 */
export async function listUtilityHistory(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<UtilityHistoryRow[]> {
  assertHouseVisible(context, houseId);

  return executor
    .select({
      periodId: utilityPeriods.id,
      month: utilityPeriods.month,
      participants: sql<number>`count(${utilityAllocations.id})::int`,
      days: sql<number>`coalesce(sum(${utilityAllocations.days}), 0)::int`,
      total: sql<number>`coalesce(sum(${utilityAllocations.amount}), 0)::int`,
    })
    .from(utilityPeriods)
    .leftJoin(utilityAllocations, eq(utilityAllocations.periodId, utilityPeriods.id))
    .where(
      and(
        periodScope(context),
        eq(utilityPeriods.houseId, houseId),
        eq(utilityPeriods.status, 'closed'),
      ),
    )
    .groupBy(utilityPeriods.id, utilityPeriods.month)
    .orderBy(desc(utilityPeriods.month));
}

export async function findClosedAllocation(
  context: AccessContext,
  filter: { houseId: string; month: BusinessDate; userId: string },
  executor: Executor = getDb(),
): Promise<UtilityAllocation | null> {
  assertHouseVisible(context, filter.houseId);

  const [row] = await executor
    .select({ allocation: utilityAllocations })
    .from(utilityAllocations)
    .innerJoin(utilityPeriods, eq(utilityPeriods.id, utilityAllocations.periodId))
    .where(
      and(
        periodScope(context),
        eq(utilityPeriods.houseId, filter.houseId),
        eq(utilityPeriods.month, filter.month),
        eq(utilityPeriods.status, 'closed'),
        eq(utilityAllocations.userId, filter.userId),
      ),
    )
    .limit(1);

  return row?.allocation ?? null;
}

export async function saveUtilityAllocations(
  periodId: string,
  allocations: readonly Omit<NewUtilityAllocation, 'periodId'>[],
  executor: Executor = getDb(),
): Promise<UtilityAllocation[]> {
  // Снимок пишется один раз на закрытие периода; переоткрытие его стирает.
  await executor.delete(utilityAllocations).where(eq(utilityAllocations.periodId, periodId));

  if (allocations.length === 0) {
    return [];
  }

  return executor
    .insert(utilityAllocations)
    .values(allocations.map((allocation) => ({ ...allocation, periodId })))
    .returning();
}
