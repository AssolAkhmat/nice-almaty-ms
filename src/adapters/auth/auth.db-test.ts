import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { UnauthorizedError } from '@/lib/errors';
import { hashPassword } from '@/lib/password';
import { SESSION_TTL_MS } from '@/lib/session-token';
import { minusMilliseconds, now, plusMilliseconds } from '@/lib/time';

import { localAuthProvider } from './local';

import type { Database, Transaction } from '@/db/client';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://nice:nice@localhost:5432/nice_almaty';
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

async function seedUser(
  tx: Transaction,
  suffix: string,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `auth-${suffix}` })
    .returning();

  const [user] = await tx
    .insert(schema.users)
    .values({
      orgId: org?.id ?? '',
      phone: `+77021${suffix}`,
      passwordHash: await hashPassword(PASSWORD),
      role: 'resident',
      mustChangePassword: false,
      ...overrides,
    })
    .returning();

  return { orgId: org?.id ?? '', user: user! };
}

describe('вход по телефону', () => {
  it('пускает по правильному паролю и заводит сессию', async () => {
    await inRollback(async (tx) => {
      const { user } = await seedUser(tx, '100001');

      const result = await localAuthProvider.signIn(
        { phone: '+77021100001', password: PASSWORD, ip: '203.0.113.1' },
        tx,
      );

      expect(result.user.id).toBe(user.id);
      expect(result.token).toHaveLength(43);
      expect(result.mustChangePassword).toBe(false);
      expect(result.usedResetPermission).toBe(false);

      const session = await localAuthProvider.getSession(result.token, tx);
      expect(session?.user.id).toBe(user.id);
      expect(session?.context.role).toBe('resident');
    });
  });

  it('принимает телефон в любой форме записи', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '100002');

      await expect(
        localAuthProvider.signIn({ phone: '87021100002', password: PASSWORD }, tx),
      ).resolves.toBeDefined();
    });
  });

  it('на неверный пароль и на несуществующий номер отвечает одинаково', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '100003');

      const wrongPassword = await localAuthProvider
        .signIn({ phone: '+77021100003', password: 'nepravilny-parol' }, tx)
        .catch((error: unknown) => error);
      const noSuchUser = await localAuthProvider
        .signIn({ phone: '+77029999999', password: PASSWORD }, tx)
        .catch((error: unknown) => error);

      expect(wrongPassword).toBeInstanceOf(UnauthorizedError);
      expect(noSuchUser).toBeInstanceOf(UnauthorizedError);
      expect((wrongPassword as Error).message).toBe((noSuchUser as Error).message);
    });
  });

  it('мусор вместо номера тоже даёт обычный отказ, а не сбой', async () => {
    await inRollback(async (tx) => {
      await expect(
        localAuthProvider.signIn({ phone: 'не телефон', password: PASSWORD }, tx),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  it('архивированный аккаунт не пускает', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '100004', { status: 'archived' });

      await expect(
        localAuthProvider.signIn({ phone: '+77021100004', password: PASSWORD }, tx),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  it('требование сменить пароль передаётся во вход', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '100005', { mustChangePassword: true });

      const result = await localAuthProvider.signIn(
        { phone: '+77021100005', password: PASSWORD },
        tx,
      );

      expect(result.mustChangePassword).toBe(true);
    });
  });
});

describe('разрешение сброса пароля', () => {
  it('пускает с любым паролем, пока действует', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '200001', {
        passwordResetAllowedUntil: plusMilliseconds(now(), 60 * 60 * 1000),
      });

      const result = await localAuthProvider.signIn(
        { phone: '+77021200001', password: 'sovershenno-lyuboy' },
        tx,
      );

      expect(result.usedResetPermission).toBe(true);
      expect(result.mustChangePassword).toBe(true);
    });
  });

  it('одноразовое: после использования гаснет', async () => {
    await inRollback(async (tx) => {
      const { user } = await seedUser(tx, '200002', {
        passwordResetAllowedUntil: plusMilliseconds(now(), 60 * 60 * 1000),
      });

      await localAuthProvider.signIn({ phone: '+77021200002', password: 'lyuboy-1' }, tx);

      const [after] = await tx.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(after?.passwordResetAllowedUntil).toBeNull();
      expect(after?.mustChangePassword).toBe(true);

      await expect(
        localAuthProvider.signIn({ phone: '+77021200002', password: 'lyuboy-2' }, tx),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  it('просроченное разрешение не действует', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '200003', {
        passwordResetAllowedUntil: minusMilliseconds(now(), 1000),
      });

      await expect(
        localAuthProvider.signIn({ phone: '+77021200003', password: 'lyuboy' }, tx),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });
});

describe('жизнь сессии', () => {
  it('отозванная сессия перестаёт действовать немедленно', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '300001');
      const { token } = await localAuthProvider.signIn(
        { phone: '+77021300001', password: PASSWORD },
        tx,
      );

      await expect(localAuthProvider.getSession(token, tx)).resolves.not.toBeNull();

      await localAuthProvider.revoke(token, tx);

      await expect(localAuthProvider.getSession(token, tx)).resolves.toBeNull();
    });
  });

  it('просроченная сессия не действует', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '300002');
      const { token } = await localAuthProvider.signIn(
        { phone: '+77021300002', password: PASSWORD },
        tx,
      );

      await tx
        .update(schema.sessions)
        .set({ expiresAt: minusMilliseconds(now(), 1000) })
        .where(eq(schema.sessions.userId, (await tx.select().from(schema.users).limit(1))[0]!.id));

      await expect(localAuthProvider.getSession(token, tx)).resolves.toBeNull();
    });
  });

  it('несуществующий токен не пускает', async () => {
    await inRollback(async (tx) => {
      await expect(localAuthProvider.getSession('чужой-токен', tx)).resolves.toBeNull();
    });
  });

  it('продление ленивое: свежая сессия не переписывается', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '300003');
      const { token, expiresAt } = await localAuthProvider.signIn(
        { phone: '+77021300003', password: PASSWORD },
        tx,
      );

      const session = await localAuthProvider.getSession(token, tx);

      expect(session?.session.expiresAt.getTime()).toBe(expiresAt.getTime());
    });
  });

  it('через сутки после последнего продления срок сдвигается', async () => {
    await inRollback(async (tx) => {
      await seedUser(tx, '300004');
      const { token } = await localAuthProvider.signIn(
        { phone: '+77021300004', password: PASSWORD },
        tx,
      );

      // Отматываем срок так, будто последнее продление было двое суток назад.
      const stale = plusMilliseconds(now(), SESSION_TTL_MS - 2 * 24 * 60 * 60 * 1000);
      await tx.update(schema.sessions).set({ expiresAt: stale });

      const session = await localAuthProvider.getSession(token, tx);

      expect(session?.session.expiresAt.getTime()).toBeGreaterThan(stale.getTime());
    });
  });

  it('архивация владельца обрывает действующую сессию', async () => {
    await inRollback(async (tx) => {
      const { user } = await seedUser(tx, '300005');
      const { token } = await localAuthProvider.signIn(
        { phone: '+77021300005', password: PASSWORD },
        tx,
      );

      await tx.update(schema.users).set({ status: 'archived' }).where(eq(schema.users.id, user.id));

      await expect(localAuthProvider.getSession(token, tx)).resolves.toBeNull();
    });
  });
});

describe('смена пароля', () => {
  it('новый пароль работает, старый — нет', async () => {
    await inRollback(async (tx) => {
      const { user } = await seedUser(tx, '400001');

      await localAuthProvider.setPassword(user.id, 'novy-parol-nadezhny', tx);

      await expect(
        localAuthProvider.signIn({ phone: '+77021400001', password: PASSWORD }, tx),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(
        localAuthProvider.signIn({ phone: '+77021400001', password: 'novy-parol-nadezhny' }, tx),
      ).resolves.toBeDefined();
    });
  });

  it('снимает требование сменить пароль и гасит разрешение сброса', async () => {
    await inRollback(async (tx) => {
      const { user } = await seedUser(tx, '400002', {
        mustChangePassword: true,
        passwordResetAllowedUntil: plusMilliseconds(now(), 60 * 60 * 1000),
      });

      await localAuthProvider.setPassword(user.id, 'novy-parol-nadezhny', tx);

      const [after] = await tx.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(after?.mustChangePassword).toBe(false);
      expect(after?.passwordResetAllowedUntil).toBeNull();
    });
  });

  it('отзывает все сессии: иначе украденная пережила бы смену пароля', async () => {
    await inRollback(async (tx) => {
      const { user } = await seedUser(tx, '400003');
      const first = await localAuthProvider.signIn(
        { phone: '+77021400003', password: PASSWORD },
        tx,
      );
      const second = await localAuthProvider.signIn(
        { phone: '+77021400003', password: PASSWORD },
        tx,
      );

      await localAuthProvider.setPassword(user.id, 'novy-parol-nadezhny', tx);

      await expect(localAuthProvider.getSession(first.token, tx)).resolves.toBeNull();
      await expect(localAuthProvider.getSession(second.token, tx)).resolves.toBeNull();
    });
  });
});
