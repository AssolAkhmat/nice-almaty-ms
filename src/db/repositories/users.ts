import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { residencies, users, type NewUser, type User } from '../schema';
import { residencyVisibility } from './residencies';

/**
 * Кого видит контекст доступа.
 *
 * Суперадмин — всю сеть. Админ — себя и учётные записи своего дома.
 * Жилец — только себя.
 *
 * Жилец не привязан к дому напрямую: `house_id` есть только у админа (D11).
 * Связь идёт через проживание, поэтому админ видит и тех, у кого есть
 * проживание в его доме, — это и есть список жильцов дома из модуля 1.
 * В фазе 1 такой связи не было, и список оставался пустым.
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

      return and(byOrg, or(byHouse, eq(users.id, context.userId), livesInVisibleHouse(context)));
    }
    case 'resident':
      return and(byOrg, eq(users.id, context.userId));
  }
}

/** У пользователя есть проживание, видимое этому контексту. */
function livesInVisibleHouse(context: AccessContext) {
  return sql`exists (
    select 1 from ${residencies}
    where ${residencies.userId} = ${users.id}
      and ${residencyVisibility(context)}
  )`;
}

export interface ListUsersOptions {
  /**
   * Порядок списка.
   *
   * `phone` — по номеру: так список ищут глазами в фильтрах журнала.
   * `newest` — новые сверху: список аккаунтов пагинируется по 25 записей
   * (инцидент I3), и заведённая только что учётная запись обязана быть
   * видна без листания. Номер для этого не годится — он случаен.
   *
   * Второй ключ у `newest` — телефон: аккаунты, заведённые в одну
   * транзакцию, получают от `now()` одно и то же время, и без него
   * их порядок остался бы на усмотрение планировщика.
   */
  order?: 'phone' | 'newest';
}

export async function listUsers(
  context: AccessContext,
  executor: Executor = getDb(),
  options: ListUsersOptions = {},
): Promise<User[]> {
  const query = executor.select().from(users).where(scope(context));

  return options.order === 'newest'
    ? query.orderBy(desc(users.createdAt), asc(users.phone))
    : query.orderBy(asc(users.phone));
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

/**
 * Пользователь сети по идентификатору, мимо ролевой видимости.
 *
 * Нужен адресации уведомлений: админ дома пишет суперадмину сети, а
 * суперадмина в его списке нет и быть не должно. Из карточки при этом
 * ничего не раскрывается — проверяется только то, что адресат
 * существует и живёт в той же сети, что и отправитель.
 */
export async function findUserInOrg(
  orgId: string,
  userId: string,
  executor: Executor = getDb(),
): Promise<User | null> {
  const [user] = await executor
    .select()
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.id, userId)))
    .limit(1);

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
