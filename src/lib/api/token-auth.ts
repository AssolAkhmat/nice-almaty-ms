import { getDb, type Executor } from '@/db/client';
import { findApiTokenByHash, touchApiToken } from '@/db/repositories/api-tokens';
import { findUserInOrg } from '@/db/repositories/users';
import { hitRateLimit } from '@/db/repositories/rate-limits';
import { isApiScope, SCOPE_ACTIONS } from '@/domain/api-scopes';
import { hashApiToken } from '@/lib/crypto/api-token';
import { retryAfterSeconds } from '@/lib/rate-limit';
import { ForbiddenError, RateLimitedError, UnauthorizedError } from '@/lib/errors';
import { now } from '@/lib/time';

import type { AccessContext } from '@/db/access';
import type { Action } from '@/lib/permissions';

/**
 * Вход по токену для ботов (docs/06-API.md, «Аутентификация»).
 *
 * Токен не носит собственной роли: он действует от имени того, кто его
 * выдал, и права берутся у этого человека в момент запроса. Понизили роль
 * или заархивировали учётную запись — токен сразу теряет то же самое.
 * Иначе выданный ключ пережил бы увольнение (P7-5).
 */
export const TOKEN_RATE_WINDOW_MS = 60 * 1000;

/** Сто двадцать запросов в минуту на токен (docs/06-API.md, «Соглашения»). */
export const TOKEN_RATE_LIMIT = 120;

export interface TokenIdentity {
  context: AccessContext;
  scopes: readonly string[];
  tokenId: string;
}

function bearerOf(request: Request): string | null {
  const header = request.headers.get('authorization');

  if (header === null) {
    return null;
  }

  const [scheme, ...rest] = header.trim().split(/\s+/);

  if (scheme?.toLowerCase() !== 'bearer') {
    return null;
  }

  const value = rest.join(' ').trim();

  return value === '' ? null : value;
}

/**
 * Кто пришёл по токену. `null` — заголовка нет вовсе, и запрос пойдёт
 * обычным путём, по сессии.
 *
 * Отозванный и просроченный токен неотличимы от несуществующего: наружу
 * уходит одно и то же «не авторизован», иначе перебором значений
 * выяснялось бы, какие из них когда-то были настоящими.
 */
export async function identifyByToken(
  request: Request,
  executor: Executor = getDb(),
): Promise<TokenIdentity | null> {
  const value = bearerOf(request);

  if (value === null) {
    return null;
  }

  const token = await findApiTokenByHash(await hashApiToken(value), executor);

  if (token === null || token.revokedAt !== null) {
    throw new UnauthorizedError('Токен недействителен');
  }

  const moment = now();

  if (token.expiresAt !== null && token.expiresAt <= moment) {
    throw new UnauthorizedError('Токен недействителен');
  }

  /*
   * Частота считается по самому токену, а не по адресу: боты ходят
   * из одного облака, и общий счётчик по IP закрывал бы одного из-за
   * другого. Хранилище то же, что у входа по телефону.
   */
  const state = await hitRateLimit(`api:token:${token.id}`, TOKEN_RATE_WINDOW_MS, executor);

  if (state.count > TOKEN_RATE_LIMIT) {
    throw new RateLimitedError(
      'Слишком часто: подождите минуту',
      retryAfterSeconds(state.windowStart, moment, TOKEN_RATE_WINDOW_MS),
    );
  }

  if (token.createdBy === null) {
    throw new UnauthorizedError('Токен недействителен');
  }

  const owner = await findUserInOrg(token.orgId, token.createdBy, executor);

  if (owner === null || owner.status !== 'active') {
    throw new UnauthorizedError('Токен недействителен');
  }

  await touchApiToken(token.id, executor);

  return {
    context: {
      orgId: token.orgId,
      userId: owner.id,
      role: owner.role,
      // Дом токена сужает область: у токена дома нет — берётся дом владельца.
      houseId: token.houseId ?? owner.houseId,
    },
    scopes: token.scopes,
    tokenId: token.id,
  };
}

/**
 * Проверка скоупа. Роль проверяется отдельно, обычным `assertCan`:
 * скоуп сужает права, а не заменяет их.
 */
export function assertScope(scopes: readonly string[], action: Action): void {
  const allowed = scopes.some((scope) => isApiScope(scope) && SCOPE_ACTIONS[scope] === action);

  if (!allowed) {
    throw new ForbiddenError('Токену не выдан нужный скоуп');
  }
}
