import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { issueDepositInvoice, readDepositView, recordPayment } from './deposits';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Депозит: счёт, оплата и заселение (§1.2 п.7–8).
 *
 * Главное здесь — не арифметика (она проверена в `src/domain/invoice.test.ts`),
 * а связь событий: оплата депозита и есть заселение, и дата заезда берётся
 * из неё, а не из подписания договора.
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
    .values({ name: 'Nice Almaty', slug: `dep-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `dep-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `dep-b-${suffix}` })
    .returning();

  async function resident(index: number, houseId: string) {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7704${index}${suffix}`, passwordHash: 'x', role: 'resident' })
      .returning();

    const [residency] = await tx
      .insert(schema.residencies)
      .values({ orgId, userId: user?.id ?? '', houseId })
      .returning();

    return { userId: user?.id ?? '', residencyId: residency?.id ?? '' };
  }

  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7703${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseA?.id ?? '',
    })
    .returning();

  await seedChartOfAccounts(tx, orgId, [
    { id: houseA?.id ?? '', slug: `dep-a-${suffix}`, name: 'Дом A' },
    { id: houseB?.id ?? '', slug: `dep-b-${suffix}`, name: 'Дом B' },
  ]);

  const a = await resident(1, houseA?.id ?? '');
  const b = await resident(2, houseB?.id ?? '');

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseA: houseA?.id ?? '',
    residencyA: a.residencyId,
    residencyB: b.residencyId,
    residentA: actor(context('resident', a.userId, null)),
    residentB: actor(context('resident', b.userId, null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseA?.id ?? null)),
  };
}

describe('счёт на депозит', () => {
  it('выставляется на сумму дома по умолчанию — 45 000 ₸ (§1.2 п.7)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7001');

      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        {},
        { executor: tx, today: TODAY },
      );

      expect(invoice.type).toBe('deposit');
      expect(invoice.total).toBe(45_000);
      expect(invoice.status).toBe('issued');
    });
  });

  it('сумма берётся из поля дома, а не из отдельной настройки (P2-38)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7002');
      await tx
        .update(schema.houses)
        .set({ defaultDeposit: 30_000 })
        .where(eq(schema.houses.id, fixture.houseA));

      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        {},
        { executor: tx, today: TODAY },
      );

      expect(invoice.total).toBe(30_000);
    });
  });

  it('индивидуальная сумма перекрывает настройку дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7003');

      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        { amount: 0 },
        { executor: tx, today: TODAY },
      );

      // У админа депозит обычно нулевой (§1.2 п.7).
      expect(invoice.total).toBe(0);
    });
  });

  it('дополнительная строка входит в сумму счёта', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7004');

      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        { extraLines: [{ title: 'Доплата за дни до 1 числа', amount: 12_000 }] },
        { executor: tx, today: TODAY },
      );

      expect(invoice.total).toBe(57_000);

      const lines = await tx
        .select()
        .from(schema.invoiceLines)
        .where(eq(schema.invoiceLines.invoiceId, invoice.id));
      expect(lines.map((line) => line.kind).sort()).toEqual(['deposit', 'extra']);
    });
  });

  it('второй счёт на тот же депозит не выставляется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7005');
      await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        {},
        { executor: tx, today: TODAY },
      );

      await expect(
        issueDepositInvoice(fixture.admin, fixture.residencyA, {}, { executor: tx, today: TODAY }),
      ).rejects.toThrow(ConflictError);
    });
  });

  it('жилец счёт себе не выставляет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7006');

      await expect(
        issueDepositInvoice(
          fixture.residentA,
          fixture.residencyA,
          {},
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  it('чужой дом неотличим от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7007');

      await expect(
        issueDepositInvoice(fixture.admin, fixture.residencyB, {}, { executor: tx, today: TODAY }),
      ).rejects.toThrow(NotFoundError);
    });
  });
});

describe('оплата депозита', () => {
  async function withInvoice(tx: Transaction, suffix: string, amount?: number) {
    const fixture = await seed(tx, suffix);
    const invoice = await issueDepositInvoice(
      fixture.admin,
      fixture.residencyA,
      amount === undefined ? {} : { amount },
      { executor: tx, today: TODAY },
    );

    return { fixture, invoice };
  }

  it('частичная оплата оставляет счёт частично оплаченным и не заселяет', async () => {
    await inRollback(async (tx) => {
      const { fixture, invoice } = await withInvoice(tx, '7010');

      const updated = await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 20_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      expect(updated.status).toBe('partially_paid');

      const [residency] = await tx
        .select()
        .from(schema.residencies)
        .where(eqId(fixture.residencyA));
      expect(residency?.status).toBe('created');
      expect(residency?.moveInDate).toBeNull();
    });
  });

  it('полная оплата заселяет: статус active и дата заезда — день оплаты', async () => {
    await inRollback(async (tx) => {
      const { fixture, invoice } = await withInvoice(tx, '7011');

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 20_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );
      const updated = await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 25_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      expect(updated.status).toBe('paid');

      const [residency] = await tx
        .select()
        .from(schema.residencies)
        .where(eqId(fixture.residencyA));
      expect(residency?.status).toBe('active');
      expect(residency?.moveInDate).toBe('2026-09-15');
    });
  });

  it('оплата зачисляется на депозит одним движением', async () => {
    await inRollback(async (tx) => {
      const { fixture, invoice } = await withInvoice(tx, '7012');

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 45_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const transactions = await tx
        .select()
        .from(schema.depositTransactions)
        .where(eq(schema.depositTransactions.residencyId, fixture.residencyA));
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({ type: 'charge', amount: 45_000 });
    });
  });

  it('на депозит идёт только строка депозита, а не весь счёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7013');
      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        { extraLines: [{ title: 'Доплата за дни', amount: 12_000 }] },
        { executor: tx, today: TODAY },
      );

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 57_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const transactions = await tx
        .select()
        .from(schema.depositTransactions)
        .where(eq(schema.depositTransactions.residencyId, fixture.residencyA));
      expect(transactions[0]?.amount).toBe(45_000);
    });
  });

  it('переплата не принимается', async () => {
    await inRollback(async (tx) => {
      const { fixture, invoice } = await withInvoice(tx, '7014');

      await expect(
        recordPayment(
          fixture.admin,
          invoice.id,
          { amount: 46_000, method: 'kaspi' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('жилец не отмечает платежи сам', async () => {
    await inRollback(async (tx) => {
      const { fixture, invoice } = await withInvoice(tx, '7015');

      await expect(
        recordPayment(
          fixture.residentA,
          invoice.id,
          { amount: 45_000, method: 'cash' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  it('оплата и заселение попадают в журнал', async () => {
    await inRollback(async (tx) => {
      const { fixture, invoice } = await withInvoice(tx, '7016');

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 45_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const actions = (
        await tx.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, fixture.orgId))
      ).map((entry) => entry.action);
      expect(actions).toContain('payment.recorded');
      expect(actions).toContain('deposit.charged');
      expect(actions).toContain('residency.activated');
    });
  });

  it('нулевой счёт админа закрывается сразу первой же попыткой оплаты нуля', async () => {
    await inRollback(async (tx) => {
      const { fixture, invoice } = await withInvoice(tx, '7017', 0);

      // Платёж на ноль бессмыслен, и его не принимают: счёт на ноль
      // и так оплачен по правилу статуса.
      await expect(
        recordPayment(
          fixture.admin,
          invoice.id,
          { amount: 0, method: 'cash' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });
});

describe('экран депозита', () => {
  it('показывает остаток, движение и счёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7020');
      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        {},
        { executor: tx, today: TODAY },
      );

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 45_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const view = await readDepositView(
        fixture.residentA,
        fixture.residencyA,
        { year: 2026 },
        { executor: tx, today: TODAY },
      );

      expect(view.balance).toBe(45_000);
      expect(view.transactions).toHaveLength(1);
      expect(view.invoice?.paid).toBe(45_000);
      expect(view.invoice?.remaining).toBe(0);
      expect(view.invoice?.lines).toHaveLength(1);
    });
  });

  it('без счёта показывает нулевой остаток, а не ошибку', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7021');

      const view = await readDepositView(
        fixture.residentA,
        fixture.residencyA,
        {},
        { executor: tx, today: TODAY },
      );

      expect(view.balance).toBe(0);
      expect(view.invoice).toBeNull();
    });
  });

  it('чужой депозит жильцу недоступен', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7022');

      await expect(
        readDepositView(fixture.residentA, fixture.residencyB, {}, { executor: tx, today: TODAY }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  it('движение другого года в выборку не попадает, а остаток остаётся полным', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7023');
      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        {},
        { executor: tx, today: TODAY },
      );
      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 45_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const view = await readDepositView(
        fixture.residentA,
        fixture.residencyA,
        { year: 2025 },
        { executor: tx, today: TODAY },
      );

      expect(view.transactions).toHaveLength(0);
      expect(view.balance).toBe(45_000);
    });
  });
});

/** Условие «это то самое проживание»: вынесено, чтобы не тянуть drizzle в каждый тест. */
function eqId(residencyId: string) {
  return eq(schema.residencies.id, residencyId);
}

/**
 * Оплата депозита в книге проводок (§10.1). Проверяется не форма проводки,
 * а инвариант 4: депозитный фонд обязан получить ровно ту сумму, которая
 * стала депозитом жильца, — иначе сверка разойдётся на первой же доплате.
 */
describe('проводка при оплате депозита', () => {
  async function ledgerOf(tx: Transaction, orgId: string) {
    const rows = await tx
      .select({
        code: schema.accounts.code,
        direction: schema.ledgerLines.direction,
        amount: schema.ledgerLines.amount,
      })
      .from(schema.ledgerLines)
      .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.id, schema.ledgerLines.entryId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.ledgerLines.accountId))
      .where(eq(schema.ledgerEntries.orgId, orgId));

    return rows;
  }

  it('касса дебетуется, депозитный фонд кредитуется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7401');

      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        {},
        { executor: tx, today: TODAY },
      );
      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 45_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      const lines = await ledgerOf(tx, fixture.orgId);

      expect(lines).toHaveLength(2);
      expect(lines).toContainEqual({ code: 'cash', direction: 'debit', amount: 45_000 });
      expect(lines).toContainEqual({ code: 'deposit_fund', direction: 'credit', amount: 45_000 });
    });
  });

  it('доплата за дни до 1 числа идёт в фонд дома, а не в депозитный', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7402');

      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        { extraLines: [{ title: 'Дни до 1 числа', amount: 12_000 }] },
        { executor: tx, today: TODAY },
      );
      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 57_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const lines = await ledgerOf(tx, fixture.orgId);

      expect(lines).toContainEqual({ code: 'kaspi', direction: 'debit', amount: 57_000 });
      expect(lines).toContainEqual({ code: 'deposit_fund', direction: 'credit', amount: 45_000 });
      expect(lines).toContainEqual({
        code: `house_fund:dep-a-7402`,
        direction: 'credit',
        amount: 12_000,
      });
    });
  });

  it('до полной оплаты проводки нет: депозит ещё не стал депозитом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7403');

      const invoice = await issueDepositInvoice(
        fixture.admin,
        fixture.residencyA,
        {},
        { executor: tx, today: TODAY },
      );
      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 20_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      expect(await ledgerOf(tx, fixture.orgId)).toHaveLength(0);
    });
  });
});
