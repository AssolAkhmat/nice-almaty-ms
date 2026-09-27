import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { createDamage } from './damages';
import {
  cancelInvoice,
  createInvoice,
  editInvoiceLines,
  listInvoicesFor,
  readInvoice,
  recalculateInvoice,
  recordPayment,
  reversePayment,
} from './invoices';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Месячные счета, строки и платежи (§3, модуль 2).
 *
 * Проверяются инварианты 5 и 6 из `02-DATA-MODEL.md` — сумма строк равна
 * итогу, переплата запрещена, — и то, что деньги попадают в книгу проводок
 * тем же движением, каким меняется статус счёта.
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
const MONTH = parseBusinessDate('2026-09-01');
const RENT = 90_000;

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `inv-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const slugA = `inv-a-${suffix}`;
  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: slugA })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `inv-b-${suffix}` })
    .returning();
  const houseAId = houseA?.id ?? '';

  await seedChartOfAccounts(tx, orgId, [
    { id: houseAId, slug: slugA, name: 'Дом A' },
    { id: houseB?.id ?? '', slug: `inv-b-${suffix}`, name: 'Дом B' },
  ]);

  const [area] = await tx
    .insert(schema.areas)
    .values({ houseId: houseAId, name: 'Комната 1', type: 'living' })
    .returning();

  async function resident(index: number, houseId: string) {
    const [user] = await tx
      .insert(schema.users)
      .values({
        orgId,
        phone: `+7709${index}${suffix}`,
        passwordHash: 'x',
        role: 'resident',
      })
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

    const [bed] = await tx
      .insert(schema.beds)
      .values({
        houseId,
        areaId: area?.id ?? '',
        number: index,
        tier: 'lower',
        label: `${String(index)} низ`,
        defaultPrice: RENT,
      })
      .returning();

    if (houseId === houseAId) {
      await tx.insert(schema.bedAssignments).values({
        residencyId: residency?.id ?? '',
        bedId: bed?.id ?? '',
        houseId: houseId,
        price: RENT,
        period: '[2026-01-01,)',
      });
    }

    return { userId: user?.id ?? '', residencyId: residency?.id ?? '' };
  }

  const a = await resident(1, houseAId);
  const b = await resident(2, houseB?.id ?? '');

  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7710${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseAId,
    })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseA: houseAId,
    houseSlugA: slugA,
    residencyA: a.residencyId,
    residencyB: b.residencyId,
    residentA: actor(context('resident', a.userId, null)),
    residentB: actor(context('resident', b.userId, null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseAId)),
    /* Сторно платежа — право суперадмина (P1-4, 27 сентября 2026). */
    superadmin: actor(context('superadmin', adminUser?.id ?? '', null)),
  };
}

async function monthly(tx: Transaction, fixture: Awaited<ReturnType<typeof seed>>) {
  return createInvoice(
    fixture.admin,
    {
      residencyId: fixture.residencyA,
      type: 'monthly',
      periodMonth: MONTH,
      lines: [
        { kind: 'rent', title: 'Проживание', amount: RENT },
        { kind: 'utilities', title: 'Коммунальные услуги за август', amount: 12_000 },
      ],
    },
    { executor: tx, today: TODAY },
  );
}

async function ledgerOf(tx: Transaction, orgId: string) {
  return tx
    .select({
      code: schema.accounts.code,
      direction: schema.ledgerLines.direction,
      amount: schema.ledgerLines.amount,
    })
    .from(schema.ledgerLines)
    .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.id, schema.ledgerLines.entryId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.ledgerLines.accountId))
    .where(eq(schema.ledgerEntries.orgId, orgId));
}

describe('строки счёта (инвариант 5)', () => {
  it('итог счёта равен сумме строк, а не приходит отдельным числом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9701');
      const invoice = await monthly(tx, fixture);

      expect(invoice.total).toBe(102_000);

      const view = await readInvoice(fixture.admin, invoice.id, { executor: tx });
      expect(view.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(view.invoice.total);
    });
  });

  it('правка строк пересобирает итог', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9702');
      const invoice = await monthly(tx, fixture);

      const updated = await editInvoiceLines(
        fixture.admin,
        invoice.id,
        [
          { kind: 'rent', title: 'Проживание', amount: RENT },
          { kind: 'extra', title: 'Замена ключа', amount: 2_000 },
        ],
        { executor: tx, today: TODAY },
      );

      expect(updated.total).toBe(92_000);
    });
  });

  it('после полной оплаты строки не правятся: только сторно и новый счёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9703');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 102_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      await expect(
        editInvoiceLines(
          fixture.admin,
          invoice.id,
          [{ kind: 'rent', title: 'Проживание', amount: 1_000 }],
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('счёт без строк не создаётся: итог не должен быть ничьим', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9704');

      await expect(
        createInvoice(
          fixture.admin,
          { residencyId: fixture.residencyA, type: 'monthly', periodMonth: MONTH, lines: [] },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe('платежи (инвариант 6)', () => {
  it('частичная оплата ведёт счёт от «Выставлен» к «Оплачен»', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9710');
      const invoice = await monthly(tx, fixture);

      const first = await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 30_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );
      expect(first.status).toBe('partially_paid');

      const second = await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 72_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );
      expect(second.status).toBe('paid');

      const view = await readInvoice(fixture.admin, invoice.id, { executor: tx });
      expect(view.payments).toHaveLength(2);
      expect(view.paid).toBe(102_000);
      expect(view.remaining).toBe(0);
    });
  });

  /*
   * Находка P1-4 (27 сентября 2026). Приложение №3 п. 4.2 договора требует
   * отметку с суммой, датой, назначением и способом платежа. Способов было
   * два из трёх, назначение не сохранялось, будущая дата принималась.
   */
  it('перевод ложится на расчётный счёт и сохраняет назначение', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9721');
      const invoice = await monthly(tx, fixture);

      const paid = await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 102_000, method: 'transfer', note: 'По договору № 12 от 20.09' },
        { executor: tx, today: TODAY },
      );

      expect(paid.status).toBe('paid');

      const view = await readInvoice(fixture.admin, invoice.id, { executor: tx });
      expect(view.payments[0]?.method).toBe('transfer');
      expect(view.payments[0]?.note).toBe('По договору № 12 от 20.09');

      /* Деньги легли на свой счёт, а не в кассу: сверка с банком сойдётся. */
      const ledger = await ledgerOf(tx, fixture.orgId);
      const bank = ledger.filter((line) => line.code === 'bank');

      expect(bank).not.toEqual([]);
      expect(
        bank
          .filter((line) => line.direction === 'debit')
          .reduce((sum, line) => sum + line.amount, 0),
      ).toBe(102_000);
    });
  });

  it('дата платежа из будущего не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9722');
      const invoice = await monthly(tx, fixture);

      await expect(
        recordPayment(
          fixture.admin,
          invoice.id,
          { amount: 1_000, method: 'cash', paidAt: new Date('2099-01-01T00:00:00Z') },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(/paidAtFuture/);
    });
  });

  /*
   * Сторно (указание владельца, 27 сентября 2026): ошибочный платёж
   * не удаляется, а сторнируется обратной проводкой. Удаление скрыло бы
   * и ошибку, и исправление, а деньги уже в налоговом отчёте и в фонде дома.
   */
  it('сторно возвращает прежний статус и не ломает баланс', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9731');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.superadmin,
        invoice.id,
        { amount: 102_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const [payment] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.invoiceId, invoice.id));

      const after = await reversePayment(
        fixture.superadmin,
        payment?.id ?? '',
        { reason: 'Приняли по ошибке: платил другой жилец' },
        { executor: tx, today: TODAY },
      );

      expect(after.status).toBe('issued');

      const view = await readInvoice(fixture.superadmin, invoice.id, { executor: tx });
      expect(view.paid).toBe(0);
      expect(view.remaining).toBe(102_000);

      /* Книга сходится: дебет и кредит по каждому счёту гасят друг друга. */
      const ledger = await ledgerOf(tx, fixture.orgId);
      const byCode = new Map<string, number>();

      for (const line of ledger) {
        const sign = line.direction === 'debit' ? 1 : -1;
        byCode.set(line.code, (byCode.get(line.code) ?? 0) + sign * line.amount);
      }

      expect([...byCode.values()].every((value) => value === 0)).toBe(true);
    });
  });

  it('частичная оплата после сторно оставляет остаток долгом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9732');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.superadmin,
        invoice.id,
        { amount: 40_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );
      await recordPayment(
        fixture.superadmin,
        invoice.id,
        { amount: 62_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      const payments = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.invoiceId, invoice.id))
        .orderBy(schema.payments.createdAt);

      const after = await reversePayment(
        fixture.superadmin,
        payments[1]?.id ?? '',
        { reason: 'Вторая отметка — дубль' },
        { executor: tx, today: TODAY },
      );

      expect(after.status).toBe('partially_paid');

      const view = await readInvoice(fixture.superadmin, invoice.id, { executor: tx });
      expect(view.paid).toBe(40_000);
      expect(view.remaining).toBe(62_000);
    });
  });

  it('второе сторно того же платежа не проходит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9733');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.superadmin,
        invoice.id,
        { amount: 102_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const [payment] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.invoiceId, invoice.id));

      await reversePayment(
        fixture.superadmin,
        payment?.id ?? '',
        { reason: 'Ошибка' },
        { executor: tx, today: TODAY },
      );

      await expect(
        reversePayment(
          fixture.superadmin,
          payment?.id ?? '',
          { reason: 'Ещё раз' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(/alreadyReversed/);
    });
  });

  it('админ дома платёж не сторнирует: это решение сети', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9734');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 102_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      const [payment] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.invoiceId, invoice.id));

      await expect(
        reversePayment(
          fixture.admin,
          payment?.id ?? '',
          { reason: 'Ошибка' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow();
    });
  });

  it('переплата запрещена', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9711');
      const invoice = await monthly(tx, fixture);

      await expect(
        recordPayment(
          fixture.admin,
          invoice.id,
          { amount: 102_001, method: 'cash' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('по отменённому счёту платёж не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9712');
      const invoice = await monthly(tx, fixture);

      await cancelInvoice(fixture.admin, invoice.id, { executor: tx, today: TODAY });

      await expect(
        recordPayment(
          fixture.admin,
          invoice.id,
          { amount: 1_000, method: 'cash' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('оплаченный счёт не отменяется: деньги уже приняты', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9713');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 102_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      await expect(
        cancelInvoice(fixture.admin, invoice.id, { executor: tx, today: TODAY }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

describe('платёж в книге проводок (§10.1)', () => {
  it('коммуналка закрывается первой и уходит в коммунальный фонд', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9720');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 12_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const lines = await ledgerOf(tx, fixture.orgId);

      expect(lines).toHaveLength(2);
      expect(lines).toContainEqual({ code: 'kaspi', direction: 'debit', amount: 12_000 });
      expect(lines).toContainEqual({ code: 'utility_fund', direction: 'credit', amount: 12_000 });
    });
  });

  it('остальное идёт в фонд дома одной проводкой с кассой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9721');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 102_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      const lines = await ledgerOf(tx, fixture.orgId);

      expect(lines).toContainEqual({ code: 'cash', direction: 'debit', amount: 102_000 });
      expect(lines).toContainEqual({ code: 'utility_fund', direction: 'credit', amount: 12_000 });
      expect(lines).toContainEqual({
        code: `house_fund:${fixture.houseSlugA}`,
        direction: 'credit',
        amount: 90_000,
      });
    });
  });
});

describe('перерасход депозита (§2.4)', () => {
  it('погашение возвращает остаток депозита к нулю и восстанавливает фонд', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9730');

      await tx.insert(schema.depositTransactions).values({
        orgId: fixture.orgId,
        residencyId: fixture.residencyA,
        type: 'charge',
        amount: 45_000,
      });
      await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Дверь', amount: 50_000, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      const invoice = await createInvoice(
        fixture.admin,
        {
          residencyId: fixture.residencyA,
          type: 'monthly',
          periodMonth: MONTH,
          lines: [
            { kind: 'rent', title: 'Проживание', amount: RENT },
            { kind: 'damage_carryover', title: 'Погашение перерасхода депозита', amount: 5_000 },
          ],
        },
        { executor: tx, today: TODAY },
      );

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 95_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      const movements = await tx
        .select({ amount: schema.depositTransactions.amount })
        .from(schema.depositTransactions)
        .where(eq(schema.depositTransactions.residencyId, fixture.residencyA));

      expect(movements.reduce((sum, row) => sum + row.amount, 0)).toBe(0);

      const lines = await ledgerOf(tx, fixture.orgId);
      expect(lines).toContainEqual({ code: 'deposit_fund', direction: 'credit', amount: 5_000 });
    });
  });
});

describe('пересчёт автоматических строк', () => {
  it('перестраивает проживание и не трогает ручные строки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9740');

      const invoice = await createInvoice(
        fixture.admin,
        {
          residencyId: fixture.residencyA,
          type: 'monthly',
          periodMonth: MONTH,
          lines: [
            { kind: 'rent', title: 'Проживание', amount: 1 },
            { kind: 'extra', title: 'Замена ключа', amount: 2_000 },
          ],
        },
        { executor: tx, today: TODAY },
      );

      const updated = await recalculateInvoice(fixture.admin, invoice.id, {
        executor: tx,
        today: TODAY,
      });

      const view = await readInvoice(fixture.admin, updated.id, { executor: tx });
      const kinds = view.lines.map((line) => [line.kind, line.amount] as const);

      expect(kinds).toContainEqual(['rent', RENT]);
      expect(kinds).toContainEqual(['extra', 2_000]);
      expect(updated.total).toBe(RENT + 2_000);
    });
  });

  it('оплаченный счёт не пересчитывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9741');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 102_000, method: 'cash' },
        { executor: tx, today: TODAY },
      );

      await expect(
        recalculateInvoice(fixture.admin, invoice.id, { executor: tx, today: TODAY }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

describe('область видимости', () => {
  it('жилец видит свои счета и не видит чужие', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9750');
      const invoice = await monthly(tx, fixture);

      const own = await listInvoicesFor(
        fixture.residentA,
        { residencyId: fixture.residencyA },
        { executor: tx },
      );
      expect(own.map((row) => row.invoice.id)).toEqual([invoice.id]);

      await expect(
        readInvoice(fixture.residentB, invoice.id, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('жилец счетов не выставляет и платежей не отмечает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9751');
      const invoice = await monthly(tx, fixture);

      await expect(
        recordPayment(
          fixture.residentA,
          invoice.id,
          { amount: 1_000, method: 'cash' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(Error);
    });
  });

  it('таблица дома показывает сводку: выставлено, оплачено, долг', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9752');
      const invoice = await monthly(tx, fixture);

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 30_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const rows = await listInvoicesFor(
        fixture.admin,
        { houseId: fixture.houseA, periodMonth: MONTH },
        { executor: tx },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.invoice.id).toBe(invoice.id);
      expect(rows[0]?.paid).toBe(30_000);
      expect(rows[0]?.remaining).toBe(72_000);
    });
  });
});
