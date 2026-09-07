import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { findApiTokenByHash } from '@/db/repositories/api-tokens';
import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { hashApiToken } from '@/lib/crypto/api-token';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseInstant } from '@/lib/time';

import { issueApiToken, listTokens, revokeToken } from './api-tokens';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Токены API (docs/06-API.md, «Аутентификация»).
 *
 * Токен выдаёт суперадмин и только в пределах своих прав. В базе лежит
 * хеш: значение показывается один раз и восстановлению не подлежит.
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

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `tok-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `tok-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  const actor = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): UserActor => ({
    context: { orgId, userId, role, houseId: forHouse },
    requestId: `req-${suffix}`,
  });

  return {
    orgId,
    houseId,
    network: actor('superadmin', superUser?.id ?? '', null),
    admin: actor('admin', adminUser?.id ?? '', houseId),
  };
}

describe('выдача токена', () => {
  it('значение показывается один раз, в базе лежит хеш', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7001');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот мест', scopes: ['beds:read', 'houses:read'] },
        { executor: tx, instant: NOW },
      );

      expect(issued.value.startsWith('nak_')).toBe(true);
      expect(issued.token.tokenHash).not.toBe(issued.value);
      expect(issued.token.tokenHash).toBe(await hashApiToken(issued.value));

      const found = await findApiTokenByHash(issued.token.tokenHash, tx);
      expect(found?.id).toBe(issued.token.id);
    });
  });

  it('срок по умолчанию — год: бессрочный ключ никто не пересмотрит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7002');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот', scopes: ['beds:read'] },
        { executor: tx, instant: NOW },
      );

      expect(issued.token.expiresAt?.toISOString().slice(0, 10)).toBe('2027-09-07');
    });
  });

  it('выдача попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7003');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот', scopes: ['beds:read'] },
        { executor: tx, instant: NOW },
      );

      const [entry] = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, issued.token.id));

      expect(entry?.action).toBe('api_token.issued');
    });
  });

  it('неизвестный скоуп не выдаётся', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7004');

      await expect(
        issueApiToken(
          fixture.network,
          { name: 'Бот', scopes: ['beds:read', 'money:steal'] },
          { executor: tx, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('токен без скоупов бессмыслен и не выдаётся', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7005');

      await expect(
        issueApiToken(fixture.network, { name: 'Бот', scopes: [] }, { executor: tx, instant: NOW }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('админ токены не выдаёт: это ключ ко всей сети', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7006');

      await expect(
        issueApiToken(
          fixture.admin,
          { name: 'Бот дома', scopes: ['beds:read'] },
          { executor: tx, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('отзыв и список', () => {
  it('отозванный токен пропадает из списка, но остаётся в базе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7007');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот', scopes: ['beds:read'] },
        { executor: tx, instant: NOW },
      );

      expect(await listTokens(fixture.network, {}, { executor: tx })).toHaveLength(1);

      const revoked = await revokeToken(fixture.network, issued.token.id, { executor: tx });
      expect(revoked.revokedAt).not.toBeNull();

      expect(await listTokens(fixture.network, {}, { executor: tx })).toEqual([]);
      expect(
        await listTokens(fixture.network, { includeRevoked: true }, { executor: tx }),
      ).toHaveLength(1);
    });
  });

  it('повторный отзыв не переписывает момент первого', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7008');

      const issued = await issueApiToken(
        fixture.network,
        { name: 'Бот', scopes: ['beds:read'] },
        { executor: tx, instant: NOW },
      );

      const first = await revokeToken(fixture.network, issued.token.id, { executor: tx });
      const second = await revokeToken(fixture.network, issued.token.id, { executor: tx });

      expect(second.revokedAt?.toISOString()).toBe(first.revokedAt?.toISOString());
    });
  });

  it('токен чужой сети не отзывается и не читается', async () => {
    await inRollback(async (tx) => {
      const mine = await seed(tx, '7009');
      const other = await seed(tx, '7010');

      const issued = await issueApiToken(
        other.network,
        { name: 'Чужой бот', scopes: ['beds:read'] },
        { executor: tx, instant: NOW },
      );

      await expect(
        revokeToken(mine.network, issued.token.id, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(await listTokens(mine.network, {}, { executor: tx })).toEqual([]);
    });
  });
});
