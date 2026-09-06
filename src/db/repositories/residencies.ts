import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { periodLiteral } from '../period';
import {
  bedAssignments,
  residencies,
  type BedAssignment,
  type NewResidency,
  type Residency,
} from '../schema';

/**
 * Проживание и занятость мест.
 *
 * С этой таблицы начинается настоящая видимость жильцов для админа:
 * в фазе 1 её не было, и список жильцов дома оставался пустым (D11).
 */
function houseScope(context: AccessContext) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return sql`true`;
  }

  return visible.length === 0 ? sql`false` : inArray(residencies.houseId, [...visible]);
}

/** Жилец видит только своё проживание, админ — проживания своего дома. */
function scope(context: AccessContext) {
  const byOrg = eq(residencies.orgId, context.orgId);

  return context.role === 'resident'
    ? and(byOrg, eq(residencies.userId, context.userId))
    : and(byOrg, houseScope(context));
}

export async function listResidencies(
  context: AccessContext,
  filter: { houseId?: string; status?: Residency['status'] } = {},
  executor: Executor = getDb(),
): Promise<Residency[]> {
  const conditions = [scope(context)];

  if (filter.houseId !== undefined) {
    assertHouseVisible(context, filter.houseId);
    conditions.push(eq(residencies.houseId, filter.houseId));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(residencies.status, filter.status));
  }

  return executor
    .select()
    .from(residencies)
    .where(and(...conditions))
    .orderBy(desc(residencies.createdAt));
}

export async function findResidency(
  context: AccessContext,
  residencyId: string,
  executor: Executor = getDb(),
): Promise<Residency | null> {
  const [residency] = await executor
    .select()
    .from(residencies)
    .where(and(scope(context), eq(residencies.id, residencyId)))
    .limit(1);

  return residency ?? null;
}

export async function requireResidency(
  context: AccessContext,
  residencyId: string,
  executor: Executor = getDb(),
): Promise<Residency> {
  const residency = await findResidency(context, residencyId, executor);
  if (residency === null) {
    throw new NotFoundError('Проживание не найдено');
  }

  return residency;
}

export async function createResidency(
  context: AccessContext,
  input: Omit<NewResidency, 'orgId'>,
  executor: Executor = getDb(),
): Promise<Residency> {
  assertHouseVisible(context, input.houseId);

  const [residency] = await executor
    .insert(residencies)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (residency === undefined) {
    throw new Error('Проживание не создано');
  }

  return residency;
}

export async function updateResidency(
  context: AccessContext,
  residencyId: string,
  patch: Partial<Omit<NewResidency, 'id' | 'orgId'>>,
  executor: Executor = getDb(),
): Promise<Residency | null> {
  const [residency] = await executor
    .update(residencies)
    .set({ ...patch, updatedAt: now() })
    .where(and(scope(context), eq(residencies.id, residencyId)))
    .returning();

  return residency ?? null;
}

/** Действующее назначение: то, у которого верхняя граница периода не задана. */
export async function findOpenAssignment(
  residencyId: string,
  executor: Executor = getDb(),
): Promise<BedAssignment | null> {
  const [assignment] = await executor
    .select()
    .from(bedAssignments)
    .where(
      and(eq(bedAssignments.residencyId, residencyId), sql`upper_inf(${bedAssignments.period})`),
    )
    .limit(1);

  return assignment ?? null;
}

export async function listAssignments(
  residencyId: string,
  executor: Executor = getDb(),
): Promise<BedAssignment[]> {
  return executor
    .select()
    .from(bedAssignments)
    .where(eq(bedAssignments.residencyId, residencyId))
    .orderBy(desc(bedAssignments.createdAt));
}

/**
 * Назначает место с указанной даты. Прежнее назначение закрывается той же
 * датой, а не удаляется: история занятости должна сохраниться, и ограничение
 * исключения всё равно не позволило бы двум периодам пересечься.
 */
export async function assignBed(
  input: {
    residencyId: string;
    bedId: string;
    price: number;
    from: BusinessDate;
    createdBy?: string | null;
  },
  executor: Executor = getDb(),
): Promise<BedAssignment> {
  return executor.transaction(async (tx) => {
    const open = await findOpenAssignment(input.residencyId, tx);

    if (open !== null) {
      await tx
        .update(bedAssignments)
        .set({
          period: periodLiteral({ from: parsePeriodStart(open.period), to: input.from }),
          updatedAt: now(),
        })
        .where(eq(bedAssignments.id, open.id));
    }

    const [assignment] = await tx
      .insert(bedAssignments)
      .values({
        residencyId: input.residencyId,
        bedId: input.bedId,
        price: input.price,
        period: periodLiteral({ from: input.from, to: null }),
        createdBy: input.createdBy ?? null,
      })
      .returning();

    if (assignment === undefined) {
      throw new Error('Место не назначено');
    }

    return assignment;
  });
}

/** Освобождает место с указанной даты, не удаляя историю. */
export async function releaseBed(
  residencyId: string,
  on: BusinessDate,
  executor: Executor = getDb(),
): Promise<void> {
  const open = await findOpenAssignment(residencyId, executor);
  if (open === null) {
    return;
  }

  await executor
    .update(bedAssignments)
    .set({
      period: periodLiteral({ from: parsePeriodStart(open.period), to: on }),
      updatedAt: now(),
    })
    .where(eq(bedAssignments.id, open.id));
}

function parsePeriodStart(literal: string): BusinessDate {
  const start = /^\[(\d{4}-\d{2}-\d{2}),/.exec(literal)?.[1];

  if (start === undefined) {
    throw new RangeError(`Не удалось прочитать начало периода: ${literal}`);
  }

  return start as BusinessDate;
}
