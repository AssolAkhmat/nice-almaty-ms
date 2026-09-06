import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { RateLimitedError, UnauthorizedError } from '@/lib/errors';
import { hashPassword } from '@/lib/password';
import { LOGIN_MAX_ATTEMPTS } from '@/lib/rate-limit';

import { signIn } from './auth';

import type { Database, Transaction } from '@/db/client';

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

const PASSWORD = 'pravilny-parol-1';

async function seedUser(tx: Transaction, suffix: string): Promise<string> {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `svc-${suffix}` })
    .returning();

  await tx.insert(schema.users).values({
    orgId: org?.id ?? '',
    phone: `+77031${suffix}`,
    passwordHash: await hashPassword(PASSWORD),
    role: 'resident',
    mustChangePassword: false,
  });

  return `+77031${suffix}`;
}

describe('вход с ограничением частоты', () => {
  it('десять неудачных попыток проходят, одиннадцатая отклоняется', async () => {
    await inRollback(async (tx) => {
      const phone = await seedUser(tx, '100001');

      for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
        await expect(
          signIn({ phone, password: 'nepravilny-parol' }, tx),
          `попытка ${attempt}`,
        ).rejects.toBeInstanceOf(UnauthorizedError);
      }

      await expect(signIn({ phone, password: 'nepravilny-parol' }, tx)).rejects.toBeInstanceOf(
        RateLimitedError,
      );
    });
  });

  it('исчерпав лимит, правильный пароль тоже не пускает', async () => {
    await inRollback(async (tx) => {
      const phone = await seedUser(tx, '100002');

      for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
        await signIn({ phone, password: 'nepravilny-parol' }, tx).catch(() => undefined);
      }

      await expect(signIn({ phone, password: PASSWORD }, tx)).rejects.toBeInstanceOf(
        RateLimitedError,
      );
    });
  });

  it('в отказе сказано, сколько ждать', async () => {
    await inRollback(async (tx) => {
      const phone = await seedUser(tx, '100003');

      for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
        await signIn({ phone, password: 'nepravilny-parol' }, tx).catch(() => undefined);
      }

      const error = await signIn({ phone, password: 'nepravilny-parol' }, tx).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(RateLimitedError);
      expect((error as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
      expect((error as RateLimitedError).retryAfterSeconds).toBeLessThanOrEqual(900);
    });
  });

  it('успешный вход обнуляет счётчик', async () => {
    await inRollback(async (tx) => {
      const phone = await seedUser(tx, '100004');

      for (let attempt = 1; attempt < LOGIN_MAX_ATTEMPTS; attempt += 1) {
        await signIn({ phone, password: 'nepravilny-parol' }, tx).catch(() => undefined);
      }

      await expect(signIn({ phone, password: PASSWORD }, tx)).resolves.toBeDefined();

      // Счётчик обнулён: снова доступны все десять попыток.
      for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
        await expect(
          signIn({ phone, password: 'nepravilny-parol' }, tx),
          `попытка ${attempt} после успеха`,
        ).rejects.toBeInstanceOf(UnauthorizedError);
      }
    });
  });

  it('перебор с одного адреса ограничивается независимо от номера', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '100005');
      const ip = '203.0.113.55';

      // Номера разные и несуществующие, адрес один.
      for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
        await signIn(
          { phone: `+7705000${String(attempt).padStart(4, '0')}`, password: 'lyuboy' },
          tx,
        ).catch(() => undefined);
      }

      await expect(
        signIn({ phone: '+77059990000', password: 'lyuboy', ip }, tx),
      ).rejects.toBeInstanceOf(UnauthorizedError);

      for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
        await signIn({ phone: '+77059990000', password: 'lyuboy', ip }, tx).catch(() => undefined);
      }

      await expect(
        signIn({ phone: '+77059990001', password: 'lyuboy', ip }, tx),
      ).rejects.toBeInstanceOf(RateLimitedError);
    });
  });

  it('блокировка одного номера не мешает другому', async () => {
    await inRollback(async (tx) => {
      const first = await seedUser(tx, '100006');
      const second = await seedUser(tx, '100007');

      for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS + 1; attempt += 1) {
        await signIn({ phone: first, password: 'nepravilny-parol' }, tx).catch(() => undefined);
      }

      await expect(signIn({ phone: second, password: PASSWORD }, tx)).resolves.toBeDefined();
    });
  });

  it('мусор вместо номера считается только по адресу', async () => {
    await inRollback(async (tx) => {
      await expect(signIn({ phone: 'не телефон', password: 'lyuboy' }, tx)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });
});
