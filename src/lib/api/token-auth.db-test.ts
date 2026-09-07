import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, RateLimitedError, UnauthorizedError } from '@/lib/errors';
import { parseInstant } from '@/lib/time';
import { issueApiToken, revokeToken } from '@/services/api-tokens';

import { assertScope, identifyByToken, TOKEN_RATE_LIMIT } from './token-auth';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from '@/services/users';

/**
 * Вход по токену (docs/06-API.md, «Аутентификация»).
 *
 * Токен действует от имени выдавшего и в его правах. Отозванный,
 * просроченный и чужой неотличимы друг от друга: наружу уходит одно
 * и то же «не авторизован».
 */
const url = testDatabaseUrl();
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

afterAll(async () => {
  await client.end();
});

class Rollback extends Error {}

async function inRollback(body: (tx: Transaction) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error;
    }
  }
}

const NOW = parseInstant('2026-09-07T12:00:00+05:00');

function requestWith(value: string | null): Request {
  return new Request('https://nice.local/api/v1/houses', {
    headers: value === null ? {} : { authorization: `Bearer ${value}` },
  });
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `tka-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `tka-a-${suffix}` })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const context: AccessContext = {
    orgId,
    userId: superUser?.id ?? '',
    role: 'superadmin',
    houseId: null,
  };

  return {
    orgId,
    houseId: house?.id ?? '',
    superId: superUser?.id ?? '',
    network: { context, requestId: `req-${suffix}` } satisfies UserActor,
  };
}

describe('разбор заголовка', () => {
  it('без заголовка вход по токену не начинается', async () => {
    await inRollback(async (tx) => {
      expect(await identifyByToken(requestWith(null), tx)).toBeNull();
    });
  });

  it('чужая схема авторизации токеном не считается', async () => {
    await inRollback(async (tx) => {
      const request = new Request('https://nice.local/api/v1/houses', {
        headers: { authorization: 'Basic bG9naW46cGFzcw==' },
      });

      expect(await identifyByToken(request, tx)).toBeNull();
    });
  });

  it('выдуманное значение не пускает', async () => {
    await inRollback(async (tx) => {
      await expect(identifyByToken(requestWith('nak_nonexistent'), tx)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });
});

describe('действующий токен', () => {
  it('даёт сеть, роль выдавшего и его скоупы', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7101');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот', scopes: ['beds:read', 'houses:read'] },
        { executor: tx, instant: NOW },
      );

      const identity = await identifyByToken(requestWith(issued.value), tx);

      expect(identity?.context.orgId).toBe(fixture.orgId);
      expect(identity?.context.userId).toBe(fixture.superId);
      expect(identity?.context.role).toBe('superadmin');
      expect(identity?.scopes).toEqual(['beds:read', 'houses:read']);
    });
  });

  it('дом токена сужает область до одного дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7102');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот дома', scopes: ['beds:read'], houseId: fixture.houseId },
        { executor: tx, instant: NOW },
      );

      const identity = await identifyByToken(requestWith(issued.value), tx);

      expect(identity?.context.houseId).toBe(fixture.houseId);
    });
  });

  it('использование отмечается: по нему видно, живёт ли бот', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7103');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот', scopes: ['beds:read'] },
        { executor: tx, instant: NOW },
      );

      expect(issued.token.lastUsedAt).toBeNull();
      await identifyByToken(requestWith(issued.value), tx);

      const [stored] = await tx
        .select()
        .from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, issued.token.id));

      expect(stored?.lastUsedAt).not.toBeNull();
    });
  });
});

describe('недействующий токен', () => {
  it('отозванный не пускает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7104');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот', scopes: ['beds:read'] },
        { executor: tx, instant: NOW },
      );
      await revokeToken(fixture.network, issued.token.id, { executor: tx });

      await expect(identifyByToken(requestWith(issued.value), tx)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });

  it('просроченный не пускает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7105');

      const issued = await issueApiToken(
        fixture.network,
        {
          name: 'Бот',
          scopes: ['beds:read'],
          expiresAt: parseInstant('2020-01-01T00:00:00+05:00'),
        },
        { executor: tx, instant: NOW },
      );

      await expect(identifyByToken(requestWith(issued.value), tx)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });

  it('токен архивной учётной записи не переживает её архивации', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7106');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот', scopes: ['beds:read'] },
        { executor: tx, instant: NOW },
      );

      await tx
        .update(schema.users)
        .set({ status: 'archived' })
        .where(eq(schema.users.id, fixture.superId));

      await expect(identifyByToken(requestWith(issued.value), tx)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });

  it('частота ограничена: сто двадцать первый запрос в минуту отклоняется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7107');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот', scopes: ['beds:read'] },
        { executor: tx, instant: NOW },
      );

      for (let attempt = 0; attempt < TOKEN_RATE_LIMIT; attempt += 1) {
        await identifyByToken(requestWith(issued.value), tx);
      }

      await expect(identifyByToken(requestWith(issued.value), tx)).rejects.toBeInstanceOf(
        RateLimitedError,
      );
    });
  });
});

describe('скоупы', () => {
  it('нужный скоуп пропускает, лишний — нет', () => {
    expect(() => {
      assertScope(['beds:read'], 'bed.read');
    }).not.toThrow();

    expect(() => {
      assertScope(['beds:read'], 'invoice.read');
    }).toThrow(ForbiddenError);
  });

  it('пустой набор скоупов не открывает ничего', () => {
    expect(() => {
      assertScope([], 'bed.read');
    }).toThrow(ForbiddenError);
  });
});
