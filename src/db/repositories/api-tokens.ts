import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now } from '@/lib/time';

import { type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { apiTokens, type ApiToken } from '../schema';

/**
 * Токены API (docs/02-DATA-MODEL.md, `api_tokens`).
 *
 * Поиск по хешу идёт мимо контекста доступа: во время запроса бота
 * контекста ещё нет — он из токена и берётся. Всё остальное — только
 * внутри своей сети.
 */
export interface CreateTokenInput {
  name: string;
  tokenHash: string;
  scopes: readonly string[];
  houseId?: string | null;
  expiresAt?: Date | null;
}

export async function createApiToken(
  context: AccessContext,
  input: CreateTokenInput,
  executor: Executor = getDb(),
): Promise<ApiToken> {
  const [token] = await executor
    .insert(apiTokens)
    .values({
      orgId: context.orgId,
      name: input.name,
      tokenHash: input.tokenHash,
      scopes: [...input.scopes],
      houseId: input.houseId ?? null,
      createdBy: context.userId,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();

  if (token === undefined) {
    throw new Error('Токен не создан');
  }

  return token;
}

export async function listApiTokens(
  context: AccessContext,
  options: { includeRevoked?: boolean } = {},
  executor: Executor = getDb(),
): Promise<ApiToken[]> {
  const conditions = [eq(apiTokens.orgId, context.orgId)];

  if (options.includeRevoked !== true) {
    conditions.push(isNull(apiTokens.revokedAt));
  }

  return executor
    .select()
    .from(apiTokens)
    .where(and(...conditions))
    .orderBy(desc(apiTokens.createdAt), asc(apiTokens.id));
}

/**
 * Токен по его хешу. Без контекста: запрос бота приходит только с ним,
 * и сеть берётся из найденной строки, а не из запроса.
 */
export async function findApiTokenByHash(
  tokenHash: string,
  executor: Executor = getDb(),
): Promise<ApiToken | null> {
  const [token] = await executor
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, tokenHash))
    .limit(1);

  return token ?? null;
}

export async function requireApiToken(
  context: AccessContext,
  tokenId: string,
  executor: Executor = getDb(),
): Promise<ApiToken> {
  const [token] = await executor
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.orgId, context.orgId), eq(apiTokens.id, tokenId)))
    .limit(1);

  if (token === undefined) {
    throw new NotFoundError('Токен не найден');
  }

  return token;
}

export async function revokeApiToken(
  context: AccessContext,
  tokenId: string,
  executor: Executor = getDb(),
): Promise<ApiToken> {
  const existing = await requireApiToken(context, tokenId, executor);

  const [token] = await executor
    .update(apiTokens)
    .set({ revokedAt: existing.revokedAt ?? now(), updatedAt: now() })
    .where(eq(apiTokens.id, tokenId))
    .returning();

  return token ?? existing;
}

/** Отметка последнего использования: по ней видно, живёт ли бот. */
export async function touchApiToken(tokenId: string, executor: Executor = getDb()): Promise<void> {
  await executor
    .update(apiTokens)
    .set({ lastUsedAt: now(), updatedAt: now() })
    .where(eq(apiTokens.id, tokenId));
}
