import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { listAuditEntries } from '@/db/repositories/audit-log';
import { hashPassword } from '@/lib/password';
import { MASKED_VALUE } from '@/lib/audit-diff';
import { now, plusMilliseconds } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit, withAudit } from './audit';
import { signIn, signOut } from './auth';

import type { AccessContext } from '@/db/access';
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

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `aud-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `aud-house-${suffix}` })
    .returning();

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+77041${suffix}`,
      passwordHash: await hashPassword(PASSWORD),
      role: 'superadmin',
      mustChangePassword: false,
    })
    .returning();

  const superadmin: AccessContext = {
    orgId,
    userId: superadminUser?.id ?? '',
    role: 'superadmin',
    houseId: null,
  };

  return { orgId, houseId: house?.id ?? '', superadmin, phone: `+77041${suffix}` };
}

describe('запись в журнал', () => {
  it('в журнал попадают только изменившиеся поля', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100001');

      await recordAudit(
        { context: fixture.superadmin, ip: '203.0.113.1', requestId: 'req-1' },
        {
          action: AUDIT_ACTIONS.houseUpdated,
          entityType: 'house',
          entityId: fixture.houseId,
          before: { name: 'Дом A', address: 'Абая 1' },
          after: { name: 'Дом Б', address: 'Абая 1' },
        },
        tx,
      );

      const [entry] = await listAuditEntries(fixture.superadmin, {}, tx);

      expect(entry?.action).toBe(AUDIT_ACTIONS.houseUpdated);
      expect(entry?.before).toEqual({ name: 'Дом A' });
      expect(entry?.after).toEqual({ name: 'Дом Б' });
      expect(entry?.ip).toBe('203.0.113.1');
      expect(entry?.requestId).toBe('req-1');
    });
  });

  it('секретные значения в журнал не попадают', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100002');

      await recordAudit(
        { context: fixture.superadmin },
        {
          action: AUDIT_ACTIONS.passwordChanged,
          entityType: 'user',
          entityId: fixture.superadmin.userId,
          before: { passwordHash: 'СТАРЫЙ-ХЕШ' },
          after: { passwordHash: 'НОВЫЙ-ХЕШ' },
        },
        tx,
      );

      const [entry] = await listAuditEntries(fixture.superadmin, {}, tx);
      const serialized = JSON.stringify(entry);

      expect(serialized).not.toContain('СТАРЫЙ-ХЕШ');
      expect(serialized).not.toContain('НОВЫЙ-ХЕШ');
      expect(entry?.after).toEqual({ passwordHash: MASKED_VALUE });
    });
  });

  it('создание записывается снимком, а не разницей', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100003');

      await recordAudit(
        { context: fixture.superadmin },
        {
          action: AUDIT_ACTIONS.houseCreated,
          entityType: 'house',
          entityId: fixture.houseId,
          after: { name: 'Дом В', slug: 'dom-v' },
        },
        tx,
      );

      const [entry] = await listAuditEntries(fixture.superadmin, {}, tx);

      expect(entry?.before).toBeNull();
      expect(entry?.after).toEqual({ name: 'Дом В', slug: 'dom-v' });
    });
  });
});

describe('мутация и журнал одной транзакцией', () => {
  it('успешная мутация оставляет и изменение, и запись', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200001');

      await withAudit(
        { context: fixture.superadmin },
        async (inner) => {
          const [house] = await inner
            .update(schema.houses)
            .set({ name: 'Переименован' })
            .where(eq(schema.houses.id, fixture.houseId))
            .returning();

          return {
            result: house,
            audit: {
              action: AUDIT_ACTIONS.houseUpdated,
              entityType: 'house',
              entityId: fixture.houseId,
              before: { name: 'Дом A' },
              after: { name: 'Переименован' },
            },
          };
        },
        tx,
      );

      const [house] = await tx
        .select()
        .from(schema.houses)
        .where(eq(schema.houses.id, fixture.houseId));
      const entries = await listAuditEntries(fixture.superadmin, {}, tx);

      expect(house?.name).toBe('Переименован');
      expect(entries).toHaveLength(1);
    });
  });

  /**
   * Главный инвариант: если журнал не записался, изменения быть не должно.
   * Иначе аудит окажется набором пропусков ровно там, где он нужнее всего.
   */
  it('несостоявшаяся запись в журнал откатывает мутацию', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200002');

      const broken = await withAudit(
        // Организации с таким идентификатором нет: внешний ключ не даст записать.
        {
          context: {
            orgId: '00000000-0000-0000-0000-000000000000',
            userId: fixture.superadmin.userId,
          },
        },
        async (inner) => {
          const [house] = await inner
            .update(schema.houses)
            .set({ name: 'Не должен сохраниться' })
            .where(eq(schema.houses.id, fixture.houseId))
            .returning();

          return {
            result: house,
            audit: {
              action: AUDIT_ACTIONS.houseUpdated,
              entityType: 'house',
              entityId: fixture.houseId,
              after: { name: 'Не должен сохраниться' },
            },
          };
        },
        tx,
      ).catch((error: unknown) => error);

      expect(broken).toBeInstanceOf(Error);

      const [house] = await tx
        .select()
        .from(schema.houses)
        .where(eq(schema.houses.id, fixture.houseId));

      expect(house?.name).toBe('Дом A');
    });
  });
});

describe('журнал входа', () => {
  it('успешный вход записывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300001');

      await signIn({ phone: fixture.phone, password: PASSWORD, ip: '203.0.113.9' }, tx);

      const entries = await listAuditEntries(fixture.superadmin, {}, tx);
      expect(entries.map((entry) => entry.action)).toContain(AUDIT_ACTIONS.signIn);
      expect(entries[0]?.ip).toBe('203.0.113.9');
    });
  });

  it('вход по разрешению сброса — отдельное событие', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300002');

      await tx
        .update(schema.users)
        .set({ passwordResetAllowedUntil: plusMilliseconds(now(), 3_600_000) })
        .where(eq(schema.users.id, fixture.superadmin.userId));

      await signIn({ phone: fixture.phone, password: 'sovsem-lyuboy' }, tx);

      const entries = await listAuditEntries(fixture.superadmin, {}, tx);
      expect(entries.map((entry) => entry.action)).toContain(
        AUDIT_ACTIONS.signInWithResetPermission,
      );
    });
  });

  it('выход записывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300003');
      const { token } = await signIn({ phone: fixture.phone, password: PASSWORD }, tx);

      await signOut(token, tx);

      const entries = await listAuditEntries(fixture.superadmin, {}, tx);
      expect(entries.map((entry) => entry.action)).toContain(AUDIT_ACTIONS.signOut);
    });
  });
});
