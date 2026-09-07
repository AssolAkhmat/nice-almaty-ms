import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { createAccount, findHouseAccount } from '@/db/repositories/accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { createHouse } from './houses';
import { postEntry, reconcileDepositFund, reverseEntry, trialBalance } from './ledger';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Двойная запись (§10.1) и инварианты 3–4 из `02-DATA-MODEL.md`.
 *
 * Проверяется главное свойство книги: несбалансированная проводка не должна
 * существовать вовсе, а сверка депозитного фонда обязана показывать
 * расхождение числом, а не молчать.
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

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `ledger-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `ledger-a-${suffix}` })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77111${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+77112${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: house?.id ?? '',
    })
    .returning();

  const [residentUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77113${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: residentUser?.id ?? '',
      houseId: house?.id ?? '',
      status: 'active',
      moveInDate: '2026-09-01',
    })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  const superadmin = actor(context('superadmin', superUser?.id ?? '', null));

  const cash = await createAccount(
    superadmin.context,
    { code: 'cash', name: 'Касса', type: 'cash', isSystem: true },
    tx,
  );
  const depositFund = await createAccount(
    superadmin.context,
    { code: 'deposit_fund', name: 'Депозитный фонд', type: 'deposit_fund', isSystem: true },
    tx,
  );

  return {
    orgId,
    houseId: house?.id ?? '',
    residencyId: residency?.id ?? '',
    cashId: cash.id,
    depositFundId: depositFund.id,
    superadmin,
    admin: actor(context('admin', adminUser?.id ?? '', house?.id ?? null)),
  };
}

describe('проводка', () => {
  it('сохраняется, когда дебет равен кредиту (инвариант 3)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6001');

      const entry = await postEntry(
        fixture.superadmin,
        {
          description: 'Оплата депозита',
          sourceType: 'deposit',
          lines: [
            { accountId: fixture.cashId, direction: 'debit', amount: 45_000 },
            { accountId: fixture.depositFundId, direction: 'credit', amount: 45_000 },
          ],
        },
        { executor: tx, today: TODAY },
      );

      const lines = await tx
        .select()
        .from(schema.ledgerLines)
        .where(eq(schema.ledgerLines.entryId, entry.id));

      expect(entry.entryDate).toBe('2026-09-15');
      expect(lines).toHaveLength(2);
    });
  });

  it('несбалансированная проводка не сохраняется вовсе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6002');

      await expect(
        postEntry(
          fixture.superadmin,
          {
            description: 'Кривая проводка',
            sourceType: 'manual',
            lines: [
              { accountId: fixture.cashId, direction: 'debit', amount: 45_000 },
              { accountId: fixture.depositFundId, direction: 'credit', amount: 44_000 },
            ],
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      const entries = await tx
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.orgId, fixture.orgId));

      expect(entries).toHaveLength(0);
    });
  });

  it('односторонняя проводка тоже отвергается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6003');

      await expect(
        postEntry(
          fixture.superadmin,
          {
            description: 'Половина проводки',
            sourceType: 'manual',
            lines: [{ accountId: fixture.cashId, direction: 'debit', amount: 1_000 }],
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('нулевая и дробная сумма строки не принимаются: деньги — целые тенге', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6004');

      for (const amount of [0, 1.5]) {
        await expect(
          postEntry(
            fixture.superadmin,
            {
              description: 'Ошибка суммы',
              sourceType: 'manual',
              lines: [
                { accountId: fixture.cashId, direction: 'debit', amount },
                { accountId: fixture.depositFundId, direction: 'credit', amount },
              ],
            },
            { executor: tx, today: TODAY },
          ),
        ).rejects.toBeInstanceOf(ValidationError);
      }
    });
  });

  it('админ дома книгу проводок не ведёт: бухгалтерия — дело суперадмина', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6005');

      await expect(
        postEntry(
          fixture.admin,
          {
            description: 'Проводка от админа',
            sourceType: 'manual',
            lines: [
              { accountId: fixture.cashId, direction: 'debit', amount: 1_000 },
              { accountId: fixture.depositFundId, direction: 'credit', amount: 1_000 },
            ],
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('сторно', () => {
  it('создаёт обратную проводку и не трогает оригинал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6010');

      const original = await postEntry(
        fixture.superadmin,
        {
          description: 'Ошибочная оплата',
          sourceType: 'manual',
          lines: [
            { accountId: fixture.cashId, direction: 'debit', amount: 5_000 },
            { accountId: fixture.depositFundId, direction: 'credit', amount: 5_000 },
          ],
        },
        { executor: tx, today: TODAY },
      );

      const reversal = await reverseEntry(fixture.superadmin, original.id, {
        executor: tx,
        today: TODAY,
      });

      const balances = await trialBalance(fixture.superadmin, {}, { executor: tx });
      const cash = balances.find((row) => row.accountId === fixture.cashId);

      expect(reversal.description).toBe('Сторно: Ошибочная оплата');
      // Оригинал и сторно гасят друг друга, но обе записи остаются в журнале.
      expect(cash?.balance).toBe(0);
    });
  });

  it('дважды сторнировать одну проводку нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6011');

      const original = await postEntry(
        fixture.superadmin,
        {
          description: 'Ошибочная оплата',
          sourceType: 'manual',
          lines: [
            { accountId: fixture.cashId, direction: 'debit', amount: 5_000 },
            { accountId: fixture.depositFundId, direction: 'credit', amount: 5_000 },
          ],
        },
        { executor: tx, today: TODAY },
      );

      await reverseEntry(fixture.superadmin, original.id, { executor: tx, today: TODAY });

      await expect(
        reverseEntry(fixture.superadmin, original.id, { executor: tx, today: TODAY }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

describe('сверка депозитного фонда (инвариант 4)', () => {
  it('сходится, когда оплата депозита прошла и движением, и проводкой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6020');

      await tx.insert(schema.depositTransactions).values({
        orgId: fixture.orgId,
        residencyId: fixture.residencyId,
        type: 'charge',
        amount: 45_000,
      });

      await postEntry(
        fixture.superadmin,
        {
          description: 'Оплата депозита',
          sourceType: 'deposit',
          lines: [
            { accountId: fixture.cashId, direction: 'debit', amount: 45_000 },
            { accountId: fixture.depositFundId, direction: 'credit', amount: 45_000 },
          ],
        },
        { executor: tx, today: TODAY },
      );

      const report = await reconcileDepositFund(fixture.superadmin, { executor: tx });

      expect(report.fundBalance).toBe(45_000);
      expect(report.depositsTotal).toBe(45_000);
      expect(report.difference).toBe(0);
    });
  });

  it('деньги мимо проводки видны расхождением, а не тишиной', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6021');

      await tx.insert(schema.depositTransactions).values({
        orgId: fixture.orgId,
        residencyId: fixture.residencyId,
        type: 'charge',
        amount: 45_000,
      });

      const report = await reconcileDepositFund(fixture.superadmin, { executor: tx });

      expect(report.fundBalance).toBe(0);
      expect(report.depositsTotal).toBe(45_000);
      expect(report.difference).toBe(-45_000);
    });
  });

  it('архивное проживание в сверку не входит: его депозит уже разобран', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6022');

      await tx.insert(schema.depositTransactions).values({
        orgId: fixture.orgId,
        residencyId: fixture.residencyId,
        type: 'charge',
        amount: 45_000,
      });
      await tx
        .update(schema.residencies)
        .set({ status: 'archived' })
        .where(eq(schema.residencies.id, fixture.residencyId));

      const report = await reconcileDepositFund(fixture.superadmin, { executor: tx });

      expect(report.depositsTotal).toBe(0);
    });
  });
});

describe('фонд дома', () => {
  /*
   * Сид заводит фонды пяти домов, но дом заводится и через приложение.
   * Без собственного фонда дому некуда провести ущерб и сгоревший депозит:
   * §10.1 требует по фонду на дом, а не общую кучу на сеть.
   */
  it('появляется вместе с домом, а не только в сиде', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6030');

      const house = await createHouse(fixture.superadmin, { name: 'Дом Б' }, tx);
      const fund = await findHouseAccount(fixture.superadmin.context, house.id, 'house_fund', tx);

      expect(fund?.code).toBe(`house_fund:${house.slug}`);
      expect(fund?.isSystem).toBe(true);
      expect(fund?.houseId).toBe(house.id);
    });
  });
});
