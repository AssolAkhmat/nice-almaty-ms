import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, ValidationError } from '@/lib/errors';

import {
  archiveAccount,
  createAccount,
  readChartOfAccounts,
  renameAccount,
} from './chart-of-accounts';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * План счетов у суперадмина (T8.3, модуль 10 «Учёт»).
 *
 * Счета сети заводил только сид: после очистки боевой базы завести их было
 * нечем, а без них не проходит ни один платёж. Проверяется то, что должно
 * остаться верным всегда: системные счета не архивируются, код уникален,
 * остаток считается по проводкам.
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

interface Fixture {
  superadmin: UserActor;
  admin: UserActor;
  orgId: string;
  houseId: string;
}

async function seed(tx: Transaction, suffix: string): Promise<Fixture> {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `coa-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `coa-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [chief] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7711${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [manager] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7712${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  const actor = (userId: string, role: AccessContext['role'], house: string | null): UserActor => ({
    context: { orgId, userId, role, houseId: house },
    requestId: `coa-${suffix}`,
  });

  return {
    orgId,
    houseId,
    superadmin: actor(chief?.id ?? '', 'superadmin', null),
    admin: actor(manager?.id ?? '', 'admin', houseId),
  };
}

const INPUT = { code: 'petty_cash', name: 'Мелкая касса', type: 'cash' as const };

describe('план счетов', () => {
  it('суперадмин заводит счёт сети: несистемный, с нулевым остатком', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3001');

      const created = await createAccount(fixture.superadmin, INPUT, tx);

      expect(created.isSystem).toBe(false);
      expect(created.houseId).toBeNull();

      const rows = await readChartOfAccounts(fixture.superadmin, tx);
      const row = rows.find((item) => item.id === created.id);

      expect(row?.balance).toBe(0);
      expect(row?.houseName).toBeNull();
    });
  });

  it('остаток берётся из проводок, а не из головы', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3002');
      const cash = await createAccount(fixture.superadmin, INPUT, tx);
      const fund = await createAccount(
        fixture.superadmin,
        { code: 'fund_probe', name: 'Фонд проверки', type: 'common_fund' },
        tx,
      );

      const [entry] = await tx
        .insert(schema.ledgerEntries)
        .values({
          orgId: fixture.orgId,
          entryDate: '2026-09-15',
          description: 'проверка',
          sourceType: 'manual',
        })
        .returning();

      await tx.insert(schema.ledgerLines).values([
        { entryId: entry?.id ?? '', accountId: cash.id, direction: 'debit', amount: 15_000 },
        { entryId: entry?.id ?? '', accountId: fund.id, direction: 'credit', amount: 15_000 },
      ]);

      const rows = await readChartOfAccounts(fixture.superadmin, tx);

      expect(rows.find((item) => item.id === cash.id)?.balance).toBe(15_000);
      expect(rows.find((item) => item.id === fund.id)?.balance).toBe(-15_000);
    });
  });

  it('фонд дома виден со своим домом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3003');

      const [fund] = await tx
        .insert(schema.accounts)
        .values({
          orgId: fixture.orgId,
          houseId: fixture.houseId,
          code: 'house_fund:coa-a-3003',
          name: 'Фонд дома A',
          type: 'house_fund',
          isSystem: true,
        })
        .returning();

      const rows = await readChartOfAccounts(fixture.superadmin, tx);

      expect(rows.find((item) => item.id === fund?.id)?.houseName).toBe('Дом A');
    });
  });

  it('системный счёт не архивируется: на нём стоят типовые проводки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3004');

      const [system] = await tx
        .insert(schema.accounts)
        .values({
          orgId: fixture.orgId,
          code: 'deposit_fund',
          name: 'Депозитный фонд',
          type: 'deposit_fund',
          isSystem: true,
        })
        .returning();

      await expect(archiveAccount(fixture.superadmin, system?.id ?? '', tx)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  it('свой счёт архивируется и уходит из списка', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3005');
      const created = await createAccount(fixture.superadmin, INPUT, tx);

      await archiveAccount(fixture.superadmin, created.id, tx);

      const rows = await readChartOfAccounts(fixture.superadmin, tx);
      expect(rows.find((item) => item.id === created.id)?.isArchived).toBe(true);
    });
  });

  it('код уникален в сети и пишется латиницей', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3006');
      await createAccount(fixture.superadmin, INPUT, tx);

      await expect(createAccount(fixture.superadmin, INPUT, tx)).rejects.toThrow(ValidationError);
      await expect(
        createAccount(fixture.superadmin, { ...INPUT, code: 'Касса' }, tx),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('переименование меняет название, но не код и не тип', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3007');
      const created = await createAccount(fixture.superadmin, INPUT, tx);

      const renamed = await renameAccount(fixture.superadmin, created.id, 'Касса охраны', tx);

      expect(renamed.name).toBe('Касса охраны');
      expect(renamed.code).toBe('petty_cash');
      expect(renamed.type).toBe('cash');
    });
  });

  it('админу план счетов сети недоступен', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3008');
      const created = await createAccount(fixture.superadmin, INPUT, tx);

      await expect(readChartOfAccounts(fixture.admin, tx)).rejects.toThrow(ForbiddenError);
      await expect(createAccount(fixture.admin, INPUT, tx)).rejects.toThrow(ForbiddenError);
      await expect(renameAccount(fixture.admin, created.id, 'Своё', tx)).rejects.toThrow(
        ForbiddenError,
      );
      await expect(archiveAccount(fixture.admin, created.id, tx)).rejects.toThrow(ForbiddenError);
    });
  });
});
