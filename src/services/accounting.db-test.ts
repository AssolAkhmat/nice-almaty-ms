import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { readLedgerJournal, readTaxReport, recordExpense } from './accounting';
import { createInvoice, recordPayment } from './invoices';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Отчёты бухгалтерии и калькулятор налогов (§10, модуль 10).
 *
 * Арифметика калькулятора проверена числами в `src/domain/tax.test.ts`.
 * Здесь — что журнал отдаёт проводки со строками и фильтруется, что расход
 * становится настоящей проводкой, а калькулятор ничего не проводит.
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

const TODAY = parseBusinessDate('2026-10-15');
const INSTANT = parseInstant('2026-10-15T11:00:00+05:00');
const FROM = parseBusinessDate('2026-10-01');
const TO = parseBusinessDate('2026-10-31');
const RENT = 90_000;
const DEPOSIT = 45_000;

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `acc-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const slug = `acc-a-${suffix}`;
  const [house] = await tx.insert(schema.houses).values({ orgId, name: 'Дом A', slug }).returning();
  const houseId = house?.id ?? '';

  await seedChartOfAccounts(tx, orgId, [{ id: houseId, slug, name: 'Дом A' }]);

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7751${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7752${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7753${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: user?.id ?? '',
      houseId,
      status: 'active',
      moveInDate: '2026-01-01',
    })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    house: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: house });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseId,
    houseSlug: slug,
    residencyId: residency?.id ?? '',
    superadmin: actor(context('superadmin', superUser?.id ?? '', null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
  };
}

async function accountId(tx: Transaction, orgId: string, code: string): Promise<string> {
  const [account] = await tx
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.orgId, orgId))
    .then((rows) => rows.filter((row) => row.code === code));

  return account?.id ?? '';
}

describe('расход (модуль 10)', () => {
  it('становится проводкой: фонд дома дебетуется, касса кредитуется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9101');

      const entry = await recordExpense(
        fixture.superadmin,
        {
          category: 'chemicals',
          amount: 12_000,
          description: 'Химия для уборки',
          accountId: await accountId(tx, fixture.orgId, `house_fund:${fixture.houseSlug}`),
          paidFrom: 'cash',
          date: TODAY,
        },
        { executor: tx, today: TODAY },
      );

      expect(entry.sourceType).toBe('expense');
      expect(entry.category).toBe('chemicals');

      const lines = await tx
        .select({ direction: schema.ledgerLines.direction, amount: schema.ledgerLines.amount })
        .from(schema.ledgerLines)
        .where(eq(schema.ledgerLines.entryId, entry.id));

      expect(lines).toHaveLength(2);
      expect(lines).toContainEqual({ direction: 'debit', amount: 12_000 });
      expect(lines).toContainEqual({ direction: 'credit', amount: 12_000 });
    });
  });

  it('неизвестная категория не принимается: перечень задан модулем 10', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9102');

      await expect(
        recordExpense(
          fixture.superadmin,
          {
            category: 'что-то своё',
            amount: 1_000,
            description: 'Расход',
            accountId: await accountId(tx, fixture.orgId, 'common_fund'),
            paidFrom: 'cash',
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('расходы ведёт суперадмин: админу дома книга проводок закрыта', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9103');

      await expect(
        recordExpense(
          fixture.admin,
          {
            category: 'rent',
            amount: 1_000,
            description: 'Аренда',
            accountId: await accountId(tx, fixture.orgId, 'common_fund'),
            paidFrom: 'cash',
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('журнал проводок', () => {
  it('отдаёт проводки со строками и названиями счетов', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9110');

      await recordExpense(
        fixture.superadmin,
        {
          category: 'repair',
          amount: 5_000,
          description: 'Ремонт двери',
          accountId: await accountId(tx, fixture.orgId, `house_fund:${fixture.houseSlug}`),
          paidFrom: 'kaspi',
          date: TODAY,
        },
        { executor: tx, today: TODAY },
      );

      const journal = await readLedgerJournal(
        fixture.superadmin,
        { from: FROM, to: TO },
        { executor: tx },
      );

      const entry = journal.find((row) => row.entry.description === 'Ремонт двери');

      expect(entry?.lines).toHaveLength(2);
      expect(entry?.lines.map((line) => line.code).sort()).toEqual(
        ['kaspi', `house_fund:${fixture.houseSlug}`].sort(),
      );
    });
  });

  it('фильтр по источнику отбрасывает чужие проводки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9111');

      await recordExpense(
        fixture.superadmin,
        {
          category: 'equipment',
          amount: 7_000,
          description: 'Пылесос',
          accountId: await accountId(tx, fixture.orgId, 'common_fund'),
          paidFrom: 'cash',
          date: TODAY,
        },
        { executor: tx, today: TODAY },
      );

      const invoice = await createInvoice(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          type: 'monthly',
          periodMonth: FROM,
          lines: [{ kind: 'rent', title: 'Проживание', amount: RENT }],
        },
        { executor: tx, today: TODAY },
      );
      await recordPayment(
        fixture.superadmin,
        invoice.id,
        { amount: RENT, method: 'kaspi' },
        { executor: tx, today: TODAY, instant: INSTANT },
      );

      const expenses = await readLedgerJournal(
        fixture.superadmin,
        { from: FROM, to: TO, sourceType: 'expense' },
        { executor: tx },
      );

      expect(expenses.map((row) => row.entry.description)).toEqual(['Пылесос']);
    });
  });

  it('админу дома журнал не открывается (§10.1)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9112');

      await expect(readLedgerJournal(fixture.admin, {}, { executor: tx })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});

describe('калькулятор налогов (§10.2)', () => {
  it('считает по платежам Kaspi и не создаёт проводок', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9120');

      const invoice = await createInvoice(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          type: 'monthly',
          periodMonth: FROM,
          lines: [{ kind: 'rent', title: 'Проживание', amount: RENT }],
        },
        { executor: tx, today: TODAY },
      );
      await recordPayment(
        fixture.superadmin,
        invoice.id,
        { amount: RENT, method: 'kaspi' },
        { executor: tx, today: TODAY, instant: INSTANT },
      );

      const before = await tx
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.orgId, fixture.orgId));

      const report = await readTaxReport(
        fixture.superadmin,
        { from: FROM, to: TO },
        { executor: tx },
      );

      expect(report.totals.kaspiIncome).toBe(RENT);
      expect(report.totals.kaspiTurnover).toBe(RENT);
      // 90 000 × 3 % = 2700; × 0,95 % = 855.
      expect(report.report.tax).toBe(2_700);
      expect(report.report.acquiring).toBe(855);

      const after = await tx
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.orgId, fixture.orgId));

      expect(after).toHaveLength(before.length);
    });
  });

  it('депозит в доход не входит, но в оборот эквайринга входит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9121');

      const deposit = await tx
        .insert(schema.invoices)
        .values({
          orgId: fixture.orgId,
          houseId: fixture.houseId,
          userId:
            (
              await tx
                .select()
                .from(schema.residencies)
                .where(eq(schema.residencies.id, fixture.residencyId))
                .limit(1)
            )[0]?.userId ?? '',
          residencyId: fixture.residencyId,
          type: 'deposit',
          status: 'issued',
          total: DEPOSIT,
        })
        .returning();

      await tx.insert(schema.payments).values({
        invoiceId: deposit[0]?.id ?? '',
        amount: DEPOSIT,
        method: 'kaspi',
        paidAt: INSTANT,
      });

      const report = await readTaxReport(
        fixture.superadmin,
        { from: FROM, to: TO },
        { executor: tx },
      );

      expect(report.totals.kaspiTurnover).toBe(DEPOSIT);
      expect(report.totals.kaspiIncome).toBe(0);
    });
  });

  it('разбивка по домам показывает каждый дом отдельно', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9122');

      const invoice = await createInvoice(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          type: 'monthly',
          periodMonth: FROM,
          lines: [{ kind: 'rent', title: 'Проживание', amount: RENT }],
        },
        { executor: tx, today: TODAY },
      );
      await recordPayment(
        fixture.superadmin,
        invoice.id,
        { amount: RENT, method: 'kaspi' },
        { executor: tx, today: TODAY, instant: INSTANT },
      );

      const report = await readTaxReport(
        fixture.superadmin,
        { from: FROM, to: TO },
        { executor: tx },
      );

      const house = report.byHouse.find((row) => row.houseId === fixture.houseId);

      expect(house?.income).toBe(RENT);
      expect(house?.report.tax).toBe(2_700);
    });
  });

  it('наличные в расчёт не попадают: эквайринга по ним нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9123');

      const invoice = await createInvoice(
        fixture.superadmin,
        {
          residencyId: fixture.residencyId,
          type: 'monthly',
          periodMonth: FROM,
          lines: [{ kind: 'rent', title: 'Проживание', amount: RENT }],
        },
        { executor: tx, today: TODAY },
      );
      await recordPayment(
        fixture.superadmin,
        invoice.id,
        { amount: RENT, method: 'cash' },
        { executor: tx, today: TODAY, instant: INSTANT },
      );

      const report = await readTaxReport(
        fixture.superadmin,
        { from: FROM, to: TO },
        { executor: tx },
      );

      expect(report.totals.kaspiTurnover).toBe(0);
    });
  });
});
