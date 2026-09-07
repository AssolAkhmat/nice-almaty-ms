import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { putRatingRule } from '@/db/repositories/rating';
import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { generateMonthlyInvoices } from './monthly-invoices';
import { addFine, addRatingEvent, approveDiscount, cancelFine, listUserFines } from './rating';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Пороги рейтинга, штрафы и скидки (docs/03-BUSINESS-RULES.md §5.3–5.5, §3).
 *
 * Пересечение порога вниз даёт долг по дополнительной ротации и штраф;
 * штраф попадает строкой в ближайший месячный счёт. Порог вверх создаёт
 * предложение скидки, которое подтверждает суперадмин.
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

const TODAY = parseBusinessDate('2026-09-07');
const NOW = parseInstant('2026-09-07T12:00:00+05:00');
/** Первое число следующего месяца: момент генерации счетов (§3). */
const FIRST_OF_NEXT = parseInstant('2026-10-01T00:05:00+05:00');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `thr-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const slug = `thr-a-${suffix}`;
  const [house] = await tx.insert(schema.houses).values({ orgId, name: 'Дом A', slug }).returning();
  const houseId = house?.id ?? '';

  await seedChartOfAccounts(tx, orgId, [{ id: houseId, slug, name: 'Дом A' }]);

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'living', name: 'Комната 1' })
    .returning();

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();
  const [dwellerUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: dwellerUser?.id ?? '',
      houseId,
      status: 'active',
      moveInDate: '2026-09-01',
    })
    .returning();

  const [bed] = await tx
    .insert(schema.beds)
    .values({ houseId, areaId: room?.id ?? '', label: 'М1', tier: 'lower', number: 1 })
    .returning();

  await tx.insert(schema.bedAssignments).values({
    residencyId: residency?.id ?? '',
    bedId: bed?.id ?? '',
    price: 100_000,
    period: '[2026-09-01,)',
  });

  const context = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: forHouse });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseId,
    residencyId: residency?.id ?? '',
    userId: dwellerUser?.id ?? '',
    superadmin: actor(context('superadmin', superadminUser?.id ?? '', null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    dweller: actor(context('resident', dwellerUser?.id ?? '', null)),
  };
}

/** Крупные дельты, чтобы дойти до порога одним событием. */
async function tuneDeltas(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
  deltas: Record<string, number>,
): Promise<void> {
  for (const [code, delta] of Object.entries(deltas)) {
    await putRatingRule(
      fixture.superadmin.context,
      { kind: 'admin_action', houseId: fixture.houseId, code, config: { delta } },
      tx,
    );
  }
}

async function event(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
  type: string,
  today = TODAY,
): Promise<void> {
  await addRatingEvent(
    fixture.admin,
    { userId: fixture.userId, type, reason: `Событие ${type}` },
    { executor: tx, today, instant: NOW },
  );
}

async function debtsOf(tx: Transaction, userId: string): Promise<number> {
  const rows = await tx
    .select()
    .from(schema.rotationDebts)
    .where(eq(schema.rotationDebts.userId, userId));

  return rows.length;
}

describe('пороги вниз (§5.3)', () => {
  it('падение ниже 40 даёт долг по дополнительной ротации без штрафа', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5601');
      await tuneDeltas(tx, fixture, { violation: -11 });

      await event(tx, fixture, 'violation');

      expect(await debtsOf(tx, fixture.userId)).toBe(1);
      expect(await listUserFines(fixture.admin, fixture.userId, { executor: tx })).toEqual([]);
    });
  });

  it('падение ниже 30 даёт и долг, и штраф 2500', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5602');
      await tuneDeltas(tx, fixture, { violation: -21 });

      await event(tx, fixture, 'violation');

      const fines = await listUserFines(fixture.admin, fixture.userId, { executor: tx });

      // 50 → 29: пересечены оба взведённых порога, каждый по разу (§5.2).
      expect(await debtsOf(tx, fixture.userId)).toBe(2);
      expect(fines.map((fine) => [fine.amount, fine.status])).toEqual([[2_500, 'pending']]);
    });
  });

  it('второй раз подряд порог не срабатывает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5603');
      await tuneDeltas(tx, fixture, { violation: -11, warning: -1 });

      await event(tx, fixture, 'violation');
      await event(tx, fixture, 'warning');

      expect(await debtsOf(tx, fixture.userId)).toBe(1);
    });
  });

  it('возврат выше порога перезаряжает его', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5604');
      await tuneDeltas(tx, fixture, { violation: -11, help: 3 });

      await event(tx, fixture, 'violation');
      await event(tx, fixture, 'help');
      await event(tx, fixture, 'violation');

      expect(await debtsOf(tx, fixture.userId)).toBe(2);
    });
  });
});

describe('пороги вверх (§5.4)', () => {
  it('порог вверх создаёт предложение скидки, а не саму скидку', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5611');
      await tuneDeltas(tx, fixture, { help: 25 });

      await event(tx, fixture, 'help');

      const [discount] = await tx
        .select()
        .from(schema.discounts)
        .where(eq(schema.discounts.userId, fixture.userId));

      expect(discount?.status).toBe('proposed');
      expect(discount?.amount).toBe(2_500);
    });
  });

  it('подтверждает скидку только суперадмин', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5612');
      await tuneDeltas(tx, fixture, { help: 25 });
      await event(tx, fixture, 'help');

      const [discount] = await tx
        .select()
        .from(schema.discounts)
        .where(eq(schema.discounts.userId, fixture.userId));

      await expect(
        approveDiscount(fixture.admin, discount?.id ?? '', { executor: tx, instant: NOW }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const approved = await approveDiscount(fixture.superadmin, discount?.id ?? '', {
        executor: tx,
        instant: NOW,
      });

      expect(approved.status).toBe('approved');
    });
  });
});

describe('штрафы и скидки в счёте (§3, §5.5)', () => {
  it('штраф попадает строкой в ближайший счёт и становится применённым', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5621');
      await tuneDeltas(tx, fixture, { violation: -21 });
      await event(tx, fixture, 'violation');

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_NEXT });

      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.residencyId, fixture.residencyId));
      const lines = await tx
        .select()
        .from(schema.invoiceLines)
        .where(eq(schema.invoiceLines.invoiceId, invoice?.id ?? ''));

      expect(lines.filter((line) => line.kind === 'fine').map((line) => line.amount)).toEqual([
        2_500,
      ]);
      expect(invoice?.total).toBe(102_500);

      const fines = await listUserFines(fixture.admin, fixture.userId, { executor: tx });

      expect(fines[0]?.status).toBe('applied');
      expect(fines[0]?.invoiceId).toBe(invoice?.id);
    });
  });

  it('до применения штраф просто отменяется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5622');
      await tuneDeltas(tx, fixture, { violation: -21 });
      await event(tx, fixture, 'violation');

      const [fine] = await listUserFines(fixture.admin, fixture.userId, { executor: tx });

      await expect(
        cancelFine(fixture.admin, fine?.id ?? '', 'Разобрались', { executor: tx, instant: NOW }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const cancelled = await cancelFine(fixture.superadmin, fine?.id ?? '', 'Разобрались', {
        executor: tx,
        instant: NOW,
      });

      expect(cancelled.status).toBe('cancelled');

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_NEXT });

      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.residencyId, fixture.residencyId));

      expect(invoice?.total).toBe(100_000);
    });
  });

  it('после применения штраф сторнируется строкой в том же счёте', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5623');
      await tuneDeltas(tx, fixture, { violation: -21 });
      await event(tx, fixture, 'violation');
      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_NEXT });

      const [fine] = await listUserFines(fixture.admin, fixture.userId, { executor: tx });

      await cancelFine(fixture.superadmin, fine?.id ?? '', 'Ошибка админа', {
        executor: tx,
        instant: NOW,
      });

      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.residencyId, fixture.residencyId));
      const lines = await tx
        .select()
        .from(schema.invoiceLines)
        .where(eq(schema.invoiceLines.invoiceId, invoice?.id ?? ''));

      expect(lines.filter((line) => line.kind === 'fine').map((line) => line.amount)).toEqual([
        2_500, -2_500,
      ]);
      expect(invoice?.total).toBe(100_000);
    });
  });

  it('причина отмены штрафа обязательна', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5624');
      await tuneDeltas(tx, fixture, { violation: -21 });
      await event(tx, fixture, 'violation');

      const [fine] = await listUserFines(fixture.admin, fixture.userId, { executor: tx });

      await expect(
        cancelFine(fixture.superadmin, fine?.id ?? '', '  ', { executor: tx, instant: NOW }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('подтверждённая скидка применяется, пока рейтинг держится выше порога', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5625');
      await tuneDeltas(tx, fixture, { help: 25, violation: -20 });
      await event(tx, fixture, 'help');

      const [discount] = await tx
        .select()
        .from(schema.discounts)
        .where(eq(schema.discounts.userId, fixture.userId));

      await approveDiscount(fixture.superadmin, discount?.id ?? '', { executor: tx, instant: NOW });

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_NEXT });

      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.residencyId, fixture.residencyId));

      expect(invoice?.total).toBe(97_500);
    });
  });

  it('упавший рейтинг скидку не применяет, но подтверждения не отзывает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5626');
      await tuneDeltas(tx, fixture, { help: 25, violation: -20 });
      await event(tx, fixture, 'help');

      const [discount] = await tx
        .select()
        .from(schema.discounts)
        .where(eq(schema.discounts.userId, fixture.userId));

      await approveDiscount(fixture.superadmin, discount?.id ?? '', { executor: tx, instant: NOW });
      await event(tx, fixture, 'violation');

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_NEXT });

      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.residencyId, fixture.residencyId));
      const [stillApproved] = await tx
        .select()
        .from(schema.discounts)
        .where(eq(schema.discounts.id, discount?.id ?? ''));

      expect(invoice?.total).toBe(100_000);
      expect(stillApproved?.status).toBe('approved');
    });
  });

  it('из двух подтверждённых скидок применяется наибольшая', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5627');
      await tuneDeltas(tx, fixture, { help: 45 });
      await event(tx, fixture, 'help');

      const proposed = await tx
        .select()
        .from(schema.discounts)
        .where(eq(schema.discounts.userId, fixture.userId));

      expect(proposed).toHaveLength(2);

      for (const discount of proposed) {
        await approveDiscount(fixture.superadmin, discount.id, { executor: tx, instant: NOW });
      }

      await generateMonthlyInvoices({ executor: tx, instant: FIRST_OF_NEXT });

      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.residencyId, fixture.residencyId));

      expect(invoice?.total).toBe(95_000);
    });
  });
});

describe('ручной штраф (модуль 8)', () => {
  it('админ начисляет штраф с причиной, жилец — нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5631');

      await expect(
        addFine(
          fixture.dweller,
          { userId: fixture.userId, amount: 1_000, reason: 'Сам себе' },
          { executor: tx, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const fine = await addFine(
        fixture.admin,
        { userId: fixture.userId, amount: 1_000, reason: 'Разбитая посуда' },
        { executor: tx, instant: NOW },
      );

      expect(fine.amount).toBe(1_000);
      expect(fine.status).toBe('pending');

      await expect(
        addFine(
          fixture.admin,
          { userId: fixture.userId, amount: 1_000, reason: '  ' },
          { executor: tx, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        addFine(
          fixture.admin,
          { userId: fixture.userId, amount: 0, reason: 'Ноль' },
          { executor: tx, instant: NOW },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
