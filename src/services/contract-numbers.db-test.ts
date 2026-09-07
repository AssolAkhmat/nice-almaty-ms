import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { parseBusinessDate } from '@/lib/time';

import { ensureContractNumber, nextNumberForOrg } from './contract-numbers';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';

/**
 * Номер договора на живой базе (T8.1).
 *
 * Проверяется то, чего чистая функция знать не может: что номер берётся
 * из своей сети, продолжается по последнему выданному и переживает
 * пятизначный порог — лексикографический максимум там даёт «9999» вечно.
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

const TODAY = parseBusinessDate('2026-09-15');

interface Fixture {
  context: AccessContext;
  houseId: string;
  userId: string;
}

async function seed(tx: Transaction, suffix: string): Promise<Fixture> {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `num-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `num-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7708${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  return {
    context: { orgId, userId: user?.id ?? '', role: 'superadmin', houseId: null },
    houseId,
    userId: user?.id ?? '',
  };
}

async function residencyWithNumber(
  tx: Transaction,
  fixture: Fixture,
  contractNumber: string | null,
): Promise<schema.Residency> {
  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId: fixture.context.orgId,
      userId: fixture.userId,
      houseId: fixture.houseId,
      status: 'created',
      contractNumber,
    })
    .returning();

  if (residency === undefined) {
    throw new Error('проживание не создано');
  }

  return residency;
}

describe('номер договора на живой базе', () => {
  it('первый номер года и продолжение нумерации', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1001');

      expect(await nextNumberForOrg(fixture.context.orgId, tx, TODAY)).toBe('2026-0001');

      await residencyWithNumber(tx, fixture, '2026-0001');

      expect(await nextNumberForOrg(fixture.context.orgId, tx, TODAY)).toBe('2026-0002');
    });
  });

  it('нумерация чужой сети своей не мешает', async () => {
    await inRollback(async (tx) => {
      const mine = await seed(tx, '1002');
      const other = await seed(tx, '1003');

      await residencyWithNumber(tx, other, '2026-0042');

      expect(await nextNumberForOrg(mine.context.orgId, tx, TODAY)).toBe('2026-0001');
    });
  });

  it('пятизначный номер продолжается, а не начинается заново', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1004');

      await residencyWithNumber(tx, fixture, '2026-9999');
      await residencyWithNumber(tx, fixture, '2026-10000');

      expect(await nextNumberForOrg(fixture.context.orgId, tx, TODAY)).toBe('2026-10001');
    });
  });

  it('проживание без номера получает его при сборке договора и не меняет потом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1005');
      const residency = await residencyWithNumber(tx, fixture, null);

      const first = await ensureContractNumber(fixture.context, residency, tx, TODAY);
      expect(first).toBe('2026-0001');

      const [stored] = await tx
        .select({ number: schema.residencies.contractNumber })
        .from(schema.residencies)
        .where(eq(schema.residencies.id, residency.id));
      expect(stored?.number).toBe('2026-0001');

      const again = await ensureContractNumber(
        fixture.context,
        { ...residency, contractNumber: first },
        tx,
        TODAY,
      );
      expect(again).toBe('2026-0001');
    });
  });

  it('два договора с одним номером в сети невозможны', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1006');
      await residencyWithNumber(tx, fixture, '2026-0001');

      await expect(residencyWithNumber(tx, fixture, '2026-0001')).rejects.toThrow();
    });
  });
});
