import { and, eq, inArray, or, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  bedAssignments,
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

/**
 * ФИО тех, кто занимал места этого дома, — и только ФИО
 * (указание владельца, 23 сентября 2026).
 *
 * Нужно для исторических записей дома: закрытый коммунальный период, счёт,
 * ущерб, ротация. Безымянная строка с суммой непроверяема, а объясняться
 * за неё придётся админу.
 *
 * Граница проведена намеренно узко: отдаётся имя, и ничего больше.
 * Телефон, документы, справки, нынешний рейтинг и дела уехавшего в новом
 * доме админу покинутого дома не отдаются — для этого есть `findProfile`,
 * и он по-прежнему не видит человека, чьё проживание числится в чужом доме.
 *
 * Право на имя выводится из занятости места, а не из «дома сейчас»:
 * колонка `bed_assignments.house_id` помнит, где человек стоял тогда.
 */
export async function listHistoricNames(
  context: AccessContext,
  houseId: string,
  userIds: readonly string[],
  executor: Executor = getDb(),
): Promise<
  { userId: string; lastName: string | null; firstName: string | null; middleName: string | null }[]
> {
  assertHouseVisible(context, houseId);

  /*
   * Без сортировки намеренно: ответ складывается в словарь «жилец — имя»,
   * и порядка у него нет. `resident_profiles` опознаётся по `user_id`,
   * колонки `id` там нет вовсе — устойчивый ключ сортировки взять было бы
   * неоткуда, а списка, который читает человек, здесь и нет.
   */

  if (userIds.length === 0) {
    return [];
  }

  const occupants = executor
    .select({ id: residencies.userId })
    .from(bedAssignments)
    .innerJoin(residencies, eq(residencies.id, bedAssignments.residencyId))
    .where(and(eq(residencies.orgId, context.orgId), eq(bedAssignments.houseId, houseId)));

  return executor
    .select({
      userId: residentProfiles.userId,
      lastName: residentProfiles.lastName,
      firstName: residentProfiles.firstName,
      middleName: residentProfiles.middleName,
    })
    .from(residentProfiles)
    .where(
      and(
        /* Сеть: профили чужой организации не отдаются и по прямому списку. */
        inArray(
          residentProfiles.userId,
          executor.select({ id: users.id }).from(users).where(eq(users.orgId, context.orgId)),
        ),
        inArray(residentProfiles.userId, [...userIds]),
        inArray(residentProfiles.userId, occupants),
      ),
    );
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

/**
 * ФИО по списку жильцов — для подписей на экранах (указание владельца,
 * 25 сентября 2026).
 *
 * Отдельный запрос вместо `findProfile` в цикле: экран показывает список,
 * и запрос на каждую строку стоил бы дороже самой страницы. Видимость
 * та же, что у профиля: чужого дома в ответе не будет.
 */
export async function listProfileNames(
  context: AccessContext,
  userIds: readonly string[],
  executor: Executor = getDb(),
): Promise<
  Map<string, { lastName: string | null; firstName: string | null; middleName: string | null }>
> {
  if (userIds.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      userId: residentProfiles.userId,
      lastName: residentProfiles.lastName,
      firstName: residentProfiles.firstName,
      middleName: residentProfiles.middleName,
    })
    .from(residentProfiles)
    .where(and(visibleUserIds(context, executor), inArray(residentProfiles.userId, [...userIds])));

  return new Map(
    rows.map((row) => [
      row.userId,
      { lastName: row.lastName, firstName: row.firstName, middleName: row.middleName },
    ]),
  );
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
