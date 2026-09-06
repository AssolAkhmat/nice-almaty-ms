import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  damageShares,
  damages,
  type Damage,
  type DamageShare,
  type NewDamage,
  type NewDamageShare,
} from '../schema';

/**
 * Ущерб и доли участников (docs/03-BUSINESS-RULES.md §8).
 *
 * Ущерб принадлежит дому: админ ведёт свой дом, суперадмин — сеть.
 * Жилец своих списаний здесь не читает — он видит их в движении депозита,
 * и это единственный источник, который ему нужен.
 */
function damageScope(context: AccessContext) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return eq(damages.orgId, context.orgId);
  }

  return visible.length === 0
    ? sql`false`
    : and(eq(damages.orgId, context.orgId), inArray(damages.houseId, [...visible]));
}

export async function listDamages(
  context: AccessContext,
  filter: { houseId?: string } = {},
  executor: Executor = getDb(),
): Promise<Damage[]> {
  const conditions = [damageScope(context)];

  if (filter.houseId !== undefined) {
    assertHouseVisible(context, filter.houseId);
    conditions.push(eq(damages.houseId, filter.houseId));
  }

  return executor
    .select()
    .from(damages)
    .where(and(...conditions))
    .orderBy(desc(damages.createdAt));
}

export async function requireDamage(
  context: AccessContext,
  damageId: string,
  executor: Executor = getDb(),
): Promise<Damage> {
  const [damage] = await executor
    .select()
    .from(damages)
    .where(and(damageScope(context), eq(damages.id, damageId)))
    .limit(1);

  if (damage === undefined) {
    throw new NotFoundError('Ущерб не найден');
  }

  return damage;
}

export async function createDamage(
  context: AccessContext,
  input: Omit<NewDamage, 'orgId'>,
  executor: Executor = getDb(),
): Promise<Damage> {
  assertHouseVisible(context, input.houseId);

  const [damage] = await executor
    .insert(damages)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (damage === undefined) {
    throw new Error('Ущерб не создан');
  }

  return damage;
}

export async function updateDamage(
  context: AccessContext,
  damageId: string,
  patch: Partial<Omit<NewDamage, 'id' | 'orgId' | 'houseId'>>,
  executor: Executor = getDb(),
): Promise<Damage | null> {
  const [damage] = await executor
    .update(damages)
    .set(patch)
    .where(and(damageScope(context), eq(damages.id, damageId)))
    .returning();

  return damage ?? null;
}

export async function addDamageShares(
  shares: readonly NewDamageShare[],
  executor: Executor = getDb(),
): Promise<DamageShare[]> {
  if (shares.length === 0) {
    return [];
  }

  return executor
    .insert(damageShares)
    .values([...shares])
    .returning();
}

export async function listDamageShares(
  damageId: string,
  executor: Executor = getDb(),
): Promise<DamageShare[]> {
  return executor
    .select()
    .from(damageShares)
    .where(eq(damageShares.damageId, damageId))
    .orderBy(asc(damageShares.createdAt));
}
