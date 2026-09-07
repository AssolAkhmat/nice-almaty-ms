import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { parseInstant } from '@/lib/time';

import { generateMonthlyInvoices, MONTHLY_INVOICES_JOB } from './monthly-invoices';

import type { Database, Transaction } from '@/db/client';

/**
 * Автогенерация месячных счетов (§3, `01-ARCHITECTURE.md`, задание
 * `invoices-monthly` 1 числа в 00:05).
 *
 * Главное здесь — не состав счёта (он проверен числами в
 * `src/domain/monthly-invoice.test.ts`), а то, что повторный вызов
 * не создаёт второй счёт и что «первое число» считается по календарю
 * Алматы, а не по UTC.
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

/**
 * 30 сентября 19:30 UTC — это уже 1 октября 00:30 в Алматы (UTC+5).
 * По UTC задание сгенерировало бы сентябрьские счета второй раз.
 */
const FIRST_OF_OCTOBER = parseInstant('2026-09-30T19:30:00Z');
const RENT = 90_000;

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `mon-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const slug = `mon-a-${suffix}`;
  const [house] = await tx.insert(schema.houses).values({ orgId, name: 'Дом A', slug }).returning();
  const houseId = house?.id ?? '';

  await seedChartOfAccounts(tx, orgId, [{ id: houseId, slug, name: 'Дом A' }]);

  const [area] = await tx
    .insert(schema.areas)
    .values({ houseId, name: 'Комната 1', type: 'living' })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7721${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  async function resident(index: number, status: 'active' | 'deposit_pending', price: number) {
    const [user] = await tx
      .insert(schema.users)
      .values({
        orgId,
        phone: `+7722${index}${suffix}`,
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
        status,
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
        defaultPrice: price,
      })
      .returning();

    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId: bed?.id ?? '',
      price,
      period: '[2026-01-01,)',
    });

    return { userId: user?.id ?? '', residencyId: residency?.id ?? '' };
  }

  const active = await resident(1, 'active', RENT);
  const pending = await resident(2, 'deposit_pending', RENT);

  return {
    orgId,
    houseId,
    superadminId: superUser?.id ?? '',
    active: active.residencyId,
    pending: pending.residencyId,
  };
}

async function invoicesOf(tx: Transaction, residencyId: string) {
  return tx
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.residencyId, residencyId), eq(schema.invoices.type, 'monthly')));
}

describe('генерация 1 числа', () => {
  it('выставляет счёт каждому активному проживанию за текущий месяц', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9801');

      const result = await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });

      expect(result.month).toBe('2026-10-01');
      expect(result.created).toBeGreaterThanOrEqual(1);

      const [invoice] = await invoicesOf(tx, fixture.active);

      expect(invoice?.periodMonth).toBe('2026-10-01');
      expect(invoice?.total).toBe(RENT);
      expect(invoice?.status).toBe('issued');
      // Счёт создан расписанием, а не человеком: автора у него нет.
      expect(invoice?.createdBy).toBeNull();
    });
  });

  it('месяц считается по календарю Алматы, а не по UTC', async () => {
    await inRollback(async (tx) => {
      await seed(tx, '9802');

      // 30 сентября 19:30 UTC — уже 1 октября в Алматы.
      const result = await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });

      expect(result.month).toBe('2026-10-01');
    });
  });

  it('проживание без оплаченного депозита счёта не получает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9803');

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });

      expect(await invoicesOf(tx, fixture.pending)).toHaveLength(0);
    });
  });

  it('повторный вызов не создаёт второй счёт (job_runs)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9804');

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });
      const second = await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });

      expect(second.skipped).toBe(true);
      expect(await invoicesOf(tx, fixture.active)).toHaveLength(1);
    });
  });

  it('повтор после сбоя доводит начатое, а не удваивает сделанное', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9805');

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });

      // Прогон помечен неудачным: задание вправе повториться.
      await tx
        .update(schema.jobRuns)
        .set({ status: 'failed' })
        .where(eq(schema.jobRuns.job, MONTHLY_INVOICES_JOB));

      const again = await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });

      expect(again.skipped).toBe(false);
      expect(again.created).toBe(0);
      expect(await invoicesOf(tx, fixture.active)).toHaveLength(1);
    });
  });

  it('смена цены места действует со следующего месяца (§3)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9806');

      // Цена меняется 10 октября: октябрьский счёт её уже не видит.
      await tx
        .update(schema.bedAssignments)
        .set({ period: '[2026-01-01,2026-10-10)' })
        .where(eq(schema.bedAssignments.residencyId, fixture.active));

      const [bed] = await tx
        .select()
        .from(schema.beds)
        .where(eq(schema.beds.houseId, fixture.houseId))
        .limit(1);

      await tx.insert(schema.bedAssignments).values({
        residencyId: fixture.active,
        bedId: bed?.id ?? '',
        price: 120_000,
        period: '[2026-10-10,)',
      });

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });

      const [invoice] = await invoicesOf(tx, fixture.active);
      expect(invoice?.total).toBe(RENT);
    });
  });

  it('перерасход депозита попадает строкой в счёт (§2.4)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9807');

      await tx.insert(schema.depositTransactions).values({
        orgId: fixture.orgId,
        residencyId: fixture.active,
        type: 'damage_share',
        amount: -5_000,
      });

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });

      const [invoice] = await invoicesOf(tx, fixture.active);
      expect(invoice?.total).toBe(RENT + 5_000);

      const lines = await tx
        .select()
        .from(schema.invoiceLines)
        .where(eq(schema.invoiceLines.invoiceId, invoice?.id ?? ''));

      expect(lines.map((line) => line.kind)).toContain('damage_carryover');
    });
  });

  it('прошлые счета генерация не пересчитывает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9808');

      const [residency] = await tx
        .select()
        .from(schema.residencies)
        .where(eq(schema.residencies.id, fixture.active))
        .limit(1);

      await tx.insert(schema.invoices).values({
        orgId: fixture.orgId,
        houseId: fixture.houseId,
        userId: residency?.userId ?? '',
        residencyId: fixture.active,
        type: 'monthly',
        periodMonth: '2026-09-01',
        status: 'issued',
        total: 1,
      });

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_OCTOBER });

      const september = (await invoicesOf(tx, fixture.active)).find(
        (invoice) => invoice.periodMonth === '2026-09-01',
      );

      expect(september?.total).toBe(1);
    });
  });
});
