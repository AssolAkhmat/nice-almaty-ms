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
