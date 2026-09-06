import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { NotFoundError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import {
  accountBalances,
  createAccount,
  createLedgerEntry,
  findAccountByCode,
  listAccounts,
  listLedgerEntries,
  requireAccount,
} from './accounts';
import { addDamageShares, createDamage, listDamages, requireDamage } from './damages';
import {
  addUtilityLine,
  createUtilityPeriod,
  findUtilityPeriod,
  listUtilityPeriods,
  requireUtilityPeriod,
  saveUtilityAllocations,
} from './utilities';

import type { AccessContext } from '../access';
import type { Database, Transaction } from '../client';

/**
 * Изоляция домов в деньгах фазы 3: счета, проводки, коммуналка и ущерб.
 *
 * Проверяется то же правило, что и во всех прежних репозиториях: чужой дом
 * неотличим от несуществующего. Арифметика двойной записи — в сервисе,
 * здесь только видимость и форма хранения.
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

const MONTH = parseBusinessDate('2026-09-01');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `money-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `money-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `money-b-${suffix}` })
    .returning();

  const [adminA] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+77101${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseA?.id ?? '',
    })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77102${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [resident] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77103${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: resident?.id ?? '',
      houseId: houseA?.id ?? '',
      status: 'active',
      moveInDate: '2026-09-01',
    })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  return {
    orgId,
    houseA: houseA?.id ?? '',
    houseB: houseB?.id ?? '',
    residencyId: residency?.id ?? '',
    residentId: resident?.id ?? '',
    admin: context('admin', adminA?.id ?? '', houseA?.id ?? null),
    superadmin: context('superadmin', superUser?.id ?? '', null),
  };
}

describe('план счетов', () => {
  it('счёт сети виден всем, счёт чужого дома — нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5001');

      await createAccount(
        fixture.superadmin,
        { code: `deposit-${'5001'}`, name: 'Депозитный фонд', type: 'deposit_fund' },
        tx,
      );
      await createAccount(
        fixture.superadmin,
        {
          code: `house-b-${'5001'}`,
          name: 'Фонд дома B',
          type: 'house_fund',
          houseId: fixture.houseB,
        },
        tx,
      );

      const seen = await listAccounts(fixture.admin, {}, tx);
      const codes = seen.map((account) => account.code);

      expect(codes).toContain('deposit-5001');
      expect(codes).not.toContain('house-b-5001');
    });
  });

  it('счёт чужого дома по идентификатору неотличим от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5002');

      const foreign = await createAccount(
        fixture.superadmin,
        { code: 'house-b-5002', name: 'Фонд дома B', type: 'house_fund', houseId: fixture.houseB },
        tx,
      );

      await expect(requireAccount(fixture.admin, foreign.id, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('счёт находится по коду в пределах своей сети', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5003');
      await createAccount(
        fixture.superadmin,
        { code: 'cash-5003', name: 'Касса', type: 'cash' },
        tx,
      );

      const found = await findAccountByCode(fixture.admin, 'cash-5003', tx);
      expect(found?.name).toBe('Касса');
    });
  });
});

describe('книга проводок', () => {
  it('проводка пишется вместе со строками и попадает в остатки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5010');

      const cash = await createAccount(
        fixture.superadmin,
        { code: 'cash-5010', name: 'Касса', type: 'cash' },
        tx,
      );
      const fund = await createAccount(
        fixture.superadmin,
        { code: 'deposit-5010', name: 'Депозитный фонд', type: 'deposit_fund' },
        tx,
      );

      await createLedgerEntry(
        fixture.superadmin,
        {
          entryDate: MONTH,
          description: 'Оплата депозита',
          sourceType: 'deposit',
          createdBy: fixture.superadmin.userId,
        },
        [
          { accountId: cash.id, direction: 'debit', amount: 45_000 },
          { accountId: fund.id, direction: 'credit', amount: 45_000 },
        ],
        tx,
      );

      const balances = await accountBalances(fixture.superadmin, {}, tx);
      const byAccount = new Map(balances.map((row) => [row.accountId, row]));

      expect(byAccount.get(cash.id)?.balance).toBe(45_000);
      expect(byAccount.get(fund.id)?.balance).toBe(-45_000);
    });
  });

  it('проводки фильтруются по периоду и источнику', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5011');
      const cash = await createAccount(
        fixture.superadmin,
        { code: 'cash-5011', name: 'Касса', type: 'cash' },
        tx,
      );
      const fund = await createAccount(
        fixture.superadmin,
        { code: 'fund-5011', name: 'Фонд дома', type: 'house_fund', houseId: fixture.houseA },
        tx,
      );

      const lines = [
        { accountId: cash.id, direction: 'debit' as const, amount: 1_000 },
        { accountId: fund.id, direction: 'credit' as const, amount: 1_000 },
      ];

      await createLedgerEntry(
        fixture.superadmin,
        { entryDate: parseBusinessDate('2026-08-15'), description: 'Август', sourceType: 'manual' },
        lines,
        tx,
      );
      await createLedgerEntry(
        fixture.superadmin,
        {
          entryDate: parseBusinessDate('2026-09-15'),
          description: 'Сентябрь',
          sourceType: 'invoice',
        },
        lines,
        tx,
      );

      const september = await listLedgerEntries(
        fixture.superadmin,
        { from: MONTH, to: parseBusinessDate('2026-09-30') },
        tx,
      );
      expect(september.map((entry) => entry.description)).toEqual(['Сентябрь']);

      const manual = await listLedgerEntries(fixture.superadmin, { sourceType: 'manual' }, tx);
      expect(manual.map((entry) => entry.description)).toEqual(['Август']);
    });
  });
});

describe('коммунальные периоды', () => {
  it('период чужого дома не виден и не открывается по идентификатору', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5020');

      const foreign = await createUtilityPeriod(
        fixture.superadmin,
        { houseId: fixture.houseB, month: MONTH },
        tx,
      );

      const mine = await listUtilityPeriods(fixture.admin, {}, tx);
      expect(mine).toHaveLength(0);

      await expect(requireUtilityPeriod(fixture.admin, foreign.id, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('на дом и месяц период один: второй не заводится', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5021');

      await createUtilityPeriod(fixture.admin, { houseId: fixture.houseA, month: MONTH }, tx);

      await expect(
        createUtilityPeriod(fixture.admin, { houseId: fixture.houseA, month: MONTH }, tx),
      ).rejects.toThrow();
    });
  });

  it('строки и снимок распределения хранятся при периоде', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5022');
      const period = await createUtilityPeriod(
        fixture.admin,
        { houseId: fixture.houseA, month: MONTH },
        tx,
      );

      await addUtilityLine({ periodId: period.id, title: 'Свет', amount: 12_000 }, tx);
      const saved = await saveUtilityAllocations(
        period.id,
        [{ userId: fixture.residentId, days: 30, amount: 12_000 }],
        tx,
      );

      expect(saved).toHaveLength(1);
      expect(saved[0]?.amount).toBe(12_000);

      const found = await findUtilityPeriod(fixture.admin, fixture.houseA, MONTH, tx);
      expect(found?.id).toBe(period.id);
    });
  });
});

describe('ущерб', () => {
  it('ущерб чужого дома неотличим от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5030');

      const foreign = await createDamage(
        fixture.superadmin,
        { houseId: fixture.houseB, title: 'Ручка', amount: 1_800, splitMode: 'all' },
        tx,
      );

      expect(await listDamages(fixture.admin, {}, tx)).toHaveLength(0);
      await expect(requireDamage(fixture.admin, foreign.id, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('доли участников хранятся поимённо и по одной на проживание', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5031');
      const damage = await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Ручка', amount: 1_800, splitMode: 'all' },
        tx,
      );

      await addDamageShares(
        [
          {
            damageId: damage.id,
            residencyId: fixture.residencyId,
            userId: fixture.residentId,
            amount: 100,
          },
        ],
        tx,
      );

      await expect(
        addDamageShares(
          [
            {
              damageId: damage.id,
              residencyId: fixture.residencyId,
              userId: fixture.residentId,
              amount: 100,
            },
          ],
          tx,
        ),
      ).rejects.toThrow();
    });
  });
});
