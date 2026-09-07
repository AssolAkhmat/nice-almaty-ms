import { getDb, type Executor } from '@/db/client';
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type CreateTokenInput,
} from '@/db/repositories/api-tokens';
import { SCOPE_ACTIONS, isApiScope, unknownScopes, type ApiScope } from '@/domain/api-scopes';
import { assertCan, can } from '@/lib/authz';
import { generateApiToken, hashApiToken } from '@/lib/crypto/api-token';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { now, plusMilliseconds } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { ApiToken } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Выдача и отзыв токенов API (docs/06-API.md, «Аутентификация»).
 *
 * Токен выдаёт суперадмин и только в пределах своих прав: скоуп сужает
 * то, что человек уже может, и никогда не расширяет. Значение показывается
 * один раз — в базе лежит только хеш.
 */
export interface ApiTokenDeps {
  executor?: Executor;
  instant?: Date;
}

/**
 * Срок по умолчанию — год.
 *
 * В модели данных `expires_at` необязателен, но бессрочный токен —
 * это ключ, который никто никогда не пересмотрит. Год заставляет
 * вернуться к вопросу, не мешая работе бота (P7-3).
 */
export const DEFAULT_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export interface IssueTokenInput {
  name: string;
  scopes: readonly string[];
  houseId?: string | null;
  expiresAt?: Date | null;
}

export interface IssuedToken {
  token: ApiToken;
  /** Значение целиком. Показывается один раз и больше нигде не хранится. */
  value: string;
}

export async function issueApiToken(
  actor: UserActor,
  input: IssueTokenInput,
  deps: ApiTokenDeps = {},
): Promise<IssuedToken> {
  const executor = deps.executor ?? getDb();
  const instant = deps.instant ?? now();

  // Токены заводит суперадмин: это ключ ко всей сети, а не к одному дому.
  assertCan(actor.context, 'settings.org.write', {});

  if (input.name.trim() === '') {
    throw new ValidationError('apiTokens.errors.nameRequired');
  }

  const unknown = unknownScopes(input.scopes);

  if (unknown.length > 0) {
    throw new ValidationError('apiTokens.errors.unknownScope', { scopes: unknown });
  }

  if (input.scopes.length === 0) {
    throw new ValidationError('apiTokens.errors.scopesRequired');
  }

  /*
   * Каждый скоуп проверяется правом выдающего: токен не может больше
   * человека, который его выдал. Иначе выдача стала бы способом
   * обойти собственную роль (P7-2).
   */
  for (const scope of input.scopes) {
    if (!isApiScope(scope)) {
      continue;
    }

    const allowed = can(actor.context, SCOPE_ACTIONS[scope], {
      ...(input.houseId === undefined || input.houseId === null ? {} : { houseId: input.houseId }),
    });

    if (!allowed) {
      throw new ForbiddenError(`Скоуп ${scope} шире прав выдающего`);
    }
  }

  const value = generateApiToken();
  const tokenHash = await hashApiToken(value);

  const record: CreateTokenInput = {
    name: input.name.trim(),
    tokenHash,
    scopes: input.scopes,
    houseId: input.houseId ?? null,
    expiresAt: input.expiresAt ?? plusMilliseconds(instant, DEFAULT_TOKEN_TTL_MS),
  };

  return executor.transaction(async (tx) => {
    const token = await createApiToken(actor.context, record, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.apiTokenIssued,
        entityType: 'api_token',
        entityId: token.id,
        after: {
          name: token.name,
          scopes: token.scopes.join(', '),
          houseId: token.houseId,
          expiresAt: token.expiresAt?.toISOString() ?? null,
        },
      },
      tx,
    );

    return { token, value };
  });
}

export async function listTokens(
  actor: UserActor,
  options: { includeRevoked?: boolean } = {},
  deps: ApiTokenDeps = {},
): Promise<ApiToken[]> {
  const executor = deps.executor ?? getDb();

  assertCan(actor.context, 'settings.org.read', {});

  return listApiTokens(actor.context, options, executor);
}

/** Отзыв необратим: выданное значение больше не пустит никогда. */
export async function revokeToken(
  actor: UserActor,
  tokenId: string,
  deps: ApiTokenDeps = {},
): Promise<ApiToken> {
  const executor = deps.executor ?? getDb();

  assertCan(actor.context, 'settings.org.write', {});

  return executor.transaction(async (tx) => {
    const token = await revokeApiToken(actor.context, tokenId, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.apiTokenRevoked,
        entityType: 'api_token',
        entityId: token.id,
        after: { name: token.name },
      },
      tx,
    );

    return token;
  });
}

export type { ApiScope };
