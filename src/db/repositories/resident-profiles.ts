import { and, eq, inArray, or, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  residencies,
  residentProfiles,
  users,
  type NewResidentProfile,
  type ResidentProfile,
} from '../schema';

/**
 * Профили жильцов.
 *
 * Видимость админа идёт через проживание, а не через `users.house_id`:
 * у жильца дома в учётной записи нет и не будет (D11). Именно это
 * закрывает долг фазы 1, когда список жильцов дома оставался пустым.
 */
function visibleUserIds(context: AccessContext, executor: Executor) {
  if (context.role === 'resident') {
    return eq(residentProfiles.userId, context.userId);
  }

  const byOrg = inArray(
    residentProfiles.userId,
    executor.select({ id: users.id }).from(users).where(eq(users.orgId, context.orgId)),
  );

  if (context.role === 'superadmin') {
    return byOrg;
  }

  const visible = visibleHouseIds(context);
  if (visible === 'all' || visible.length === 0) {
    return sql`false`;
  }

  // Житель виден админу, если у него есть проживание в доме этого админа.
  const byResidency = inArray(
    residentProfiles.userId,
    executor
      .select({ id: residencies.userId })
      .from(residencies)
      .where(and(eq(residencies.orgId, context.orgId), inArray(residencies.houseId, [...visible]))),
  );

  return and(byOrg, or(byResidency, eq(residentProfiles.userId, context.userId)));
}

export async function findProfile(
  context: AccessContext,
  userId: string,
  executor: Executor = getDb(),
): Promise<ResidentProfile | null> {
  const [profile] = await executor
    .select()
    .from(residentProfiles)
    .where(and(visibleUserIds(context, executor), eq(residentProfiles.userId, userId)))
    .limit(1);

  return profile ?? null;
}

/**
 * Предпочтительный способ оплаты по нескольким жильцам сразу — для списка
 * «удалёнки» (§3.1). Отдельной выборкой, а не по профилю на строку: список
 * дома за месяц иначе бил бы базу по разу на жильца.
 */
export async function listPreferredPayments(
  context: AccessContext,
  userIds: readonly string[],
  executor: Executor = getDb(),
): Promise<Map<string, ResidentProfile['preferredPayment']>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      userId: residentProfiles.userId,
      preferredPayment: residentProfiles.preferredPayment,
    })
    .from(residentProfiles)
    .where(and(visibleUserIds(context, executor), inArray(residentProfiles.userId, [...userIds])));

  return new Map(rows.map((row) => [row.userId, row.preferredPayment]));
}

export async function requireProfile(
  context: AccessContext,
  userId: string,
  executor: Executor = getDb(),
): Promise<ResidentProfile> {
  const profile = await findProfile(context, userId, executor);
  if (profile === null) {
    throw new NotFoundError('Профиль не найден');
  }

  return profile;
}

/** Создаёт профиль, если его ещё нет, и возвращает текущее состояние. */
export async function ensureProfile(
  userId: string,
  executor: Executor = getDb(),
): Promise<ResidentProfile> {
  const [profile] = await executor
    .insert(residentProfiles)
    .values({ userId })
    .onConflictDoUpdate({ target: residentProfiles.userId, set: { updatedAt: now() } })
    .returning();

  if (profile === undefined) {
    throw new Error('Профиль не создан');
  }

  return profile;
}

export async function updateProfile(
  context: AccessContext,
  userId: string,
  patch: Partial<Omit<NewResidentProfile, 'userId'>>,
  executor: Executor = getDb(),
): Promise<ResidentProfile | null> {
  const [profile] = await executor
    .update(residentProfiles)
    .set({ ...patch, updatedAt: now() })
    .where(and(visibleUserIds(context, executor), eq(residentProfiles.userId, userId)))
    .returning();

  return profile ?? null;
}
