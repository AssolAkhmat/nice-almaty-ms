import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { users, type NewUser, type User } from '../schema';

/**
 * Кого видит контекст доступа.
 *
 * Суперадмин — всю сеть. Админ — себя и учётные записи своего дома.
 * Жилец — только себя.
 *
 * В фазе 1 жилец не привязан к дому (house_id есть только у админа,
 * это следствие D11), поэтому список жильцов дома у админа пуст.
 * Связь появится в фазе 2 вместе с проживанием.
 */
function scope(context: AccessContext) {
  const byOrg = eq(users.orgId, context.orgId);

  switch (context.role) {
    case 'superadmin':
      return byOrg;
    case 'admin': {
      const visible = visibleHouseIds(context);
      const byHouse =
        visible === 'all' || visible.length === 0
          ? sql`false`
          : inArray(users.houseId, [...visible]);

      return and(byOrg, or(byHouse, eq(users.id, context.userId)));
    }
    case 'resident':
      return and(byOrg, eq(users.id, context.userId));
  }
}

export async function listUsers(
  context: AccessContext,
  executor: Executor = getDb(),
): Promise<User[]> {
  return executor.select().from(users).where(scope(context)).orderBy(asc(users.phone));
}

export async function findUser(
  context: AccessContext,
  userId: string,
  executor: Executor = getDb(),
): Promise<User | null> {
  const [user] = await executor
    .select()
    .from(users)
    .where(and(scope(context), eq(users.id, userId)))
    .limit(1);

  return user ?? null;
}

export async function requireUser(
  context: AccessContext,
  userId: string,
  executor: Executor = getDb(),
): Promise<User> {
  const user = await findUser(context, userId, executor);
  if (user === null) {
    throw new NotFoundError('Пользователь не найден');
  }

  return user;
}

/**
 * Поиск по телефону идёт мимо контекста доступа: он нужен входу,
 * когда контекста ещё нет. Телефон уникален во всей системе.
 */
export async function findUserByPhone(
  phone: string,
  executor: Executor = getDb(),
): Promise<User | null> {
  const [user] = await executor.select().from(users).where(eq(users.phone, phone)).limit(1);

  return user ?? null;
}

export async function createUser(
  context: AccessContext,
  input: Omit<NewUser, 'orgId'>,
  executor: Executor = getDb(),
): Promise<User> {
  const [user] = await executor
    .insert(users)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (user === undefined) {
    throw new Error('Пользователь не создан');
  }

  return user;
}

export async function updateUser(
  context: AccessContext,
  userId: string,
  patch: Partial<Omit<NewUser, 'id' | 'orgId'>>,
  executor: Executor = getDb(),
): Promise<User | null> {
  const [user] = await executor
    .update(users)
    .set({ ...patch, updatedAt: now() })
    .where(and(scope(context), eq(users.id, userId)))
    .returning();

  return user ?? null;
}

/**
 * Обновление служебных полей входа: последний вход, обязательная смена пароля,
 * разрешение сброса. Идёт мимо контекста доступа — во время входа его ещё нет.
 */
export async function updateUserAuthState(
  userId: string,
  patch: Pick<
    Partial<NewUser>,
    'passwordHash' | 'mustChangePassword' | 'passwordResetAllowedUntil' | 'lastLoginAt'
  >,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(users)
    .set({ ...patch, updatedAt: now() })
    .where(eq(users.id, userId));
}
