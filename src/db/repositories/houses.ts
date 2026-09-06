import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { houses, type House, type NewHouse } from '../schema';

/** Условие видимости домов для контекста доступа. */
function scope(context: AccessContext) {
  const visible = visibleHouseIds(context);
  const byOrg = eq(houses.orgId, context.orgId);

  if (visible === 'all') {
    return byOrg;
  }

  // Пустая область видимости не должна превращаться в «видно всё».
  return visible.length === 0 ? sql`false` : and(byOrg, inArray(houses.id, [...visible]));
}

export async function listHouses(
  context: AccessContext,
  options: { includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<House[]> {
  const conditions = [scope(context)];
  if (options.includeArchived !== true) {
    conditions.push(isNull(houses.archivedAt));
  }

  return executor
    .select()
    .from(houses)
    .where(and(...conditions))
    .orderBy(asc(houses.name));
}

export async function findHouse(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<House | null> {
  const [house] = await executor
    .select()
    .from(houses)
    .where(and(scope(context), eq(houses.id, houseId)))
    .limit(1);

  return house ?? null;
}

/** Дом вне области видимости неотличим от несуществующего (P1-1). */
export async function requireHouse(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<House> {
  assertHouseVisible(context, houseId);

  const house = await findHouse(context, houseId, executor);
  if (house === null) {
    throw new NotFoundError('Дом не найден');
  }

  return house;
}

export async function createHouse(
  context: AccessContext,
  input: Omit<NewHouse, 'orgId'>,
  executor: Executor = getDb(),
): Promise<House> {
  const [house] = await executor
    .insert(houses)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (house === undefined) {
    throw new Error('Дом не создан');
  }

  return house;
}

export async function updateHouse(
  context: AccessContext,
  houseId: string,
  patch: Partial<Omit<NewHouse, 'id' | 'orgId'>>,
  executor: Executor = getDb(),
): Promise<House | null> {
  assertHouseVisible(context, houseId);

  const [house] = await executor
    .update(houses)
    .set({ ...patch, updatedAt: now() })
    .where(and(scope(context), eq(houses.id, houseId)))
    .returning();

  return house ?? null;
}
