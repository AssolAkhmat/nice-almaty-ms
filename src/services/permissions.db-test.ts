import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { loadOverridesFor } from '@/db/repositories/permission-overrides';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { can } from '@/lib/authz';
import { ForbiddenError } from '@/lib/errors';

import { readAdminCapabilities, setAdminCapability } from './permissions';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Полномочия админа, которыми распоряжается сеть (D28).
 *
 * Тест написан после того, как переключатель упал на боевом: в `entity_id`
 * журнала уходило имя переключателя, а колонка — uuid (разбор I20). Проверок
 * на сервис не было вовсе, и «полномочие сохраняется и пишется в журнал»
 * держалось на словах.
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

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `perm-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `perm-a-${suffix}` })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7760${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7761${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: house?.id ?? '',
    })
    .returning();

  const context = (role: AccessContext['role'], userId: string, houseId: string | null) => ({
    orgId,
    userId,
    role,
    houseId,
  });

  return {
    orgId,
    houseId: house?.id ?? '',
    adminId: adminUser?.id ?? '',
    superadmin: { context: context('superadmin', superUser?.id ?? '', null) } as UserActor,
    admin: { context: context('admin', adminUser?.id ?? '', house?.id ?? null) } as UserActor,
  };
}

describe('переключатели полномочий админа', () => {
  it('по умолчанию все три выключены', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9101');

      expect(await readAdminCapabilities(fixture.superadmin, { executor: tx })).toEqual({
        documents: false,
        contract: false,
        secrets: false,
      });
    });
  });

  /* Тот самый путь, который падал на боевом: включение с записью в журнал. */
  it('включение сохраняется и попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9102');

      await setAdminCapability(fixture.superadmin, 'documents', true, { executor: tx });

      const capabilities = await readAdminCapabilities(fixture.superadmin, { executor: tx });
      expect(capabilities.documents).toBe(true);
      expect(capabilities.contract).toBe(false);

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.orgId, fixture.orgId));

      const changed = entries.filter((entry) => entry.action === 'permission.changed');

      expect(changed).toHaveLength(1);
      // Сеть — это и есть тот, чьи права менялись: `entity_id` здесь uuid.
      expect(changed[0]?.entityId).toBe(fixture.orgId);
      expect((changed[0]?.after as { capability?: string } | null)?.capability).toBe('documents');
      expect((changed[0]?.after as { actions?: string[] } | null)?.actions).toEqual([
        'document.read',
        'document.review',
      ]);
    });
  });

  it('выключение возвращает умолчание', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9103');

      await setAdminCapability(fixture.superadmin, 'secrets', true, { executor: tx });
      await setAdminCapability(fixture.superadmin, 'secrets', false, { executor: tx });

      expect((await readAdminCapabilities(fixture.superadmin, { executor: tx })).secrets).toBe(
        false,
      );
    });
  });

  it('включённое сетью полномочие доезжает до проверки прав', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9104');

      const before = await loadOverridesFor(fixture.orgId, fixture.adminId, tx);
      expect(
        can({ ...fixture.admin.context, overrides: before }, 'document.read', {
          houseId: fixture.houseId,
        }),
      ).toBe(false);

      await setAdminCapability(fixture.superadmin, 'documents', true, { executor: tx });

      const after = await loadOverridesFor(fixture.orgId, fixture.adminId, tx);
      expect(
        can({ ...fixture.admin.context, overrides: after }, 'document.read', {
          houseId: fixture.houseId,
        }),
      ).toBe(true);
    });
  });

  /* Личное правило сильнее сетевого: это основа будущих личных переключателей. */
  it('личное правило перебивает сетевое', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9105');

      await setAdminCapability(fixture.superadmin, 'documents', true, { executor: tx });

      await tx.insert(schema.permissionOverrides).values({
        orgId: fixture.orgId,
        userId: fixture.adminId,
        action: 'document.read',
        allowed: false,
      });

      const resolved = await loadOverridesFor(fixture.orgId, fixture.adminId, tx);

      expect(resolved['document.read']).toBe(false);
      expect(resolved['document.review']).toBe(true);
    });
  });

  it('админ переключателями не распоряжается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9106');

      /* Настройки сети админу не положены вовсе — это 403, а не 404. */
      await expect(
        setAdminCapability(fixture.admin, 'documents', true, { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
