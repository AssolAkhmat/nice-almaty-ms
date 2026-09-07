import { and, asc, eq } from 'drizzle-orm';

import { organizations, users } from '@/db/schema';

import type { AccessContext } from '@/db/access';
import type { Executor } from '@/db/client';
import type { UserActor } from './users';

/**
 * От чьего имени ходят задания планировщика (docs/01-ARCHITECTURE.md).
 *
 * Своего пользователя у расписания нет, а репозитории без контекста
 * доступа не отдают ничего (P3-16). Поэтому задание работает от имени
 * суперадмина сети — он видит все дома, включая те, где админа нет.
 */
export async function networkActors(job: string, executor: Executor): Promise<UserActor[]> {
  const networks = await executor
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(asc(organizations.createdAt), asc(organizations.id));

  const actors: UserActor[] = [];

  for (const network of networks) {
    const [superadmin] = await executor
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, network.id), eq(users.role, 'superadmin')))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1);

    if (superadmin === undefined) {
      // Сеть без суперадмина — недописанный сид; заданию тут делать нечего.
      continue;
    }

    const context: AccessContext = {
      orgId: network.id,
      userId: superadmin.id,
      role: 'superadmin',
      houseId: null,
    };

    actors.push({ context, requestId: `job:${job}` });
  }

  return actors;
}

/** Админы дома. Пусто — дом ведёт суперадмин, и это нормальное состояние. */
export async function houseAdmins(
  context: AccessContext,
  houseId: string,
  executor: Executor,
): Promise<string[]> {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.orgId, context.orgId),
        eq(users.houseId, houseId),
        eq(users.role, 'admin'),
        eq(users.status, 'active'),
      ),
    )
    .orderBy(asc(users.createdAt), asc(users.id));

  return rows.map((row) => row.id);
}

/**
 * Кому сообщать о деле дома: его админам, а если админа нет — суперадмину.
 * Дом без админа ведёт сеть, и уведомление не должно пропадать вместе
 * с отсутствующим адресатом (P6-17).
 */
export async function houseRecipients(
  actor: UserActor,
  houseId: string,
  executor: Executor,
): Promise<string[]> {
  const admins = await houseAdmins(actor.context, houseId, executor);

  return admins.length > 0 ? admins : [actor.context.userId];
}
