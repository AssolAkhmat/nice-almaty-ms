import { and, eq, gt, isNull } from 'drizzle-orm';

import { now } from '@/lib/time';

import { getDb, type Executor } from '../client';
import { sessions, users, type NewSession, type Session, type User } from '../schema';

/**
 * Сессии живут в базе, поэтому их можно отозвать (docs/01-ARCHITECTURE.md).
 * Контекста доступа тут нет: сессия и есть то, из чего он потом собирается.
 */
export async function createSession(
  input: NewSession,
  executor: Executor = getDb(),
): Promise<Session> {
  const [session] = await executor.insert(sessions).values(input).returning();

  if (session === undefined) {
    throw new Error('Сессия не создана');
  }

  return session;
}

/** Действующая сессия вместе с владельцем: отозванная и просроченная не считаются. */
export async function findLiveSession(
  tokenHash: string,
  executor: Executor = getDb(),
): Promise<{ session: Session; user: User } | null> {
  const [row] = await executor
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now()),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function extendSession(
  sessionId: string,
  expiresAt: Date,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(sessions)
    .set({ expiresAt, updatedAt: now() })
    .where(eq(sessions.id, sessionId));
}

export async function revokeSession(
  tokenHash: string,
  executor: Executor = getDb(),
): Promise<void> {
  const moment = now();

  await executor
    .update(sessions)
    .set({ revokedAt: moment, updatedAt: moment })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
}

/** Все сессии пользователя: нужно при смене пароля и архивации аккаунта. */
export async function revokeAllUserSessions(
  userId: string,
  executor: Executor = getDb(),
): Promise<void> {
  const moment = now();

  await executor
    .update(sessions)
    .set({ revokedAt: moment, updatedAt: moment })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
