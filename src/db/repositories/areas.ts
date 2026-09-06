import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { areas, beds, type Area, type Bed, type NewArea, type NewBed } from '../schema';

/**
 * Зоны и места. Оба списка фильтруются по дому: админ соседнего дома
 * не должен даже узнать, сколько там комнат.
 */
function houseScope(context: AccessContext, column: typeof areas.houseId | typeof beds.houseId) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return sql`true`;
  }

  return visible.length === 0 ? sql`false` : inArray(column, [...visible]);
}

export async function listAreas(
  context: AccessContext,
  houseId: string,
  options: { includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<Area[]> {
  assertHouseVisible(context, houseId);

  const conditions = [eq(areas.houseId, houseId), houseScope(context, areas.houseId)];
  if (options.includeArchived !== true) {
    conditions.push(isNull(areas.archivedAt));
  }

  return executor
    .select()
    .from(areas)
    .where(and(...conditions))
    .orderBy(asc(areas.sortOrder), asc(areas.name));
}

export async function requireArea(
  context: AccessContext,
  areaId: string,
  executor: Executor = getDb(),
): Promise<Area> {
  const [area] = await executor
    .select()
    .from(areas)
    .where(and(eq(areas.id, areaId), houseScope(context, areas.houseId)))
    .limit(1);

  if (area === undefined) {
    throw new NotFoundError('Зона не найдена');
  }

  return area;
}

export async function createArea(
  context: AccessContext,
  input: NewArea,
  executor: Executor = getDb(),
): Promise<Area> {
  assertHouseVisible(context, input.houseId);

  const [area] = await executor.insert(areas).values(input).returning();
  if (area === undefined) {
    throw new Error('Зона не создана');
  }

  return area;
}

export async function updateArea(
  context: AccessContext,
  areaId: string,
  patch: Partial<Omit<NewArea, 'id' | 'houseId'>>,
  executor: Executor = getDb(),
): Promise<Area | null> {
  const [area] = await executor
    .update(areas)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(areas.id, areaId), houseScope(context, areas.houseId)))
    .returning();

  return area ?? null;
}

export async function listBeds(
  context: AccessContext,
  houseId: string,
  options: { areaId?: string; includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<Bed[]> {
  assertHouseVisible(context, houseId);

  const conditions = [eq(beds.houseId, houseId), houseScope(context, beds.houseId)];
  if (options.areaId !== undefined) {
    conditions.push(eq(beds.areaId, options.areaId));
  }
  if (options.includeArchived !== true) {
    conditions.push(isNull(beds.archivedAt));
  }

  return executor
    .select()
    .from(beds)
    .where(and(...conditions))
    .orderBy(asc(beds.number), asc(beds.tier));
}

export async function requireBed(
  context: AccessContext,
  bedId: string,
  executor: Executor = getDb(),
): Promise<Bed> {
  const [bed] = await executor
    .select()
    .from(beds)
    .where(and(eq(beds.id, bedId), houseScope(context, beds.houseId)))
    .limit(1);

  if (bed === undefined) {
    throw new NotFoundError('Место не найдено');
  }

  return bed;
}

/** Место заводится только в жилой комнате: в общей зоне спать негде. */
export async function createBed(
  context: AccessContext,
  input: NewBed,
  executor: Executor = getDb(),
): Promise<Bed> {
  const area = await requireArea(context, input.areaId, executor);

  if (area.type !== 'living') {
    throw new NotFoundError('Место можно завести только в жилой комнате');
  }

  if (area.houseId !== input.houseId) {
    throw new NotFoundError('Зона принадлежит другому дому');
  }

  const [bed] = await executor.insert(beds).values(input).returning();
  if (bed === undefined) {
    throw new Error('Место не создано');
  }

  return bed;
}

export async function updateBed(
  context: AccessContext,
  bedId: string,
  patch: Partial<Omit<NewBed, 'id' | 'houseId' | 'areaId'>>,
  executor: Executor = getDb(),
): Promise<Bed | null> {
  const [bed] = await executor
    .update(beds)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(beds.id, bedId), houseScope(context, beds.houseId)))
    .returning();

  return bed ?? null;
}
