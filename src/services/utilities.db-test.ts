import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { createInvoice, readInvoice } from './invoices';
import { generateMonthlyInvoices } from './monthly-invoices';
import {
  addPeriodLine,
  closeUtilityPeriod,
  openUtilityPeriod,
  readUtilityPeriod,
  removePeriodLine,
  reopenUtilityPeriod,
} from './utilities';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Коммунальный период: заполнение, распределение, закрытие (§4, модуль 6).
 *
 * Арифметика долей проверена числами в `src/domain/utilities.test.ts`.
 * Здесь — что закрытие фиксирует снимок, доводит доли до счетов и что
 * период, закрытый после 1 числа, дописывает строку в уже выставленный счёт.
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

/** Коммуналка за октябрь попадает в ноябрьский счёт (§3). */
const OCTOBER = parseBusinessDate('2026-10-01');
const NOVEMBER = parseBusinessDate('2026-11-01');
const IN_NOVEMBER = parseBusinessDate('2026-11-05');
const INSTANT = parseInstant('2026-11-05T11:00:00+05:00');

/**
 * Заезды подобраны под пример §4.1: 10, 20 и 30 прожитых дней в октябре
 * (31 день). День заезда считается прожитым.
 */
const MOVE_INS = ['2026-10-22', '2026-10-12', '2026-10-02'] as const;

async function seed(tx: Transaction, suffix: string, moveIns: readonly string[] = MOVE_INS) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `utl-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const slug = `utl-a-${suffix}`;
  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `utl-b-${suffix}` })
    .returning();
  const houseId = houseA?.id ?? '';

  await seedChartOfAccounts(tx, orgId, [
    { id: houseId, slug, name: 'Дом A' },
    { id: houseB?.id ?? '', slug: `utl-b-${suffix}`, name: 'Дом B' },
  ]);

  const [area] = await tx
    .insert(schema.areas)
    .values({ houseId, name: 'Комната 1', type: 'living' })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7731${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const residents: { userId: string; residencyId: string }[] = [];

  for (const [index, moveIn] of moveIns.entries()) {
    const [user] = await tx
      .insert(schema.users)
      .values({
        orgId,
        phone: `+7732${index}${suffix}`,
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
        moveInDate: moveIn,
      })
      .returning();

    const [bed] = await tx
      .insert(schema.beds)
      .values({
        houseId,
        areaId: area?.id ?? '',
        number: index + 1,
        tier: 'lower',
        label: `${String(index + 1)} низ`,
        defaultPrice: 90_000,
      })
      .returning();

    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId: bed?.id ?? '',
      price: 90_000,
      period: `[${moveIn},)`,
    });

    residents.push({ userId: user?.id ?? '', residencyId: residency?.id ?? '' });
  }

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7733${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    house: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: house });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseA: houseId,
    houseB: houseB?.id ?? '',
    houseSlugA: slug,
    residents,
    superadmin: actor(context('superadmin', superUser?.id ?? '', null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    adminOfB: actor(context('admin', adminUser?.id ?? '', houseB?.id ?? '')),
    resident: actor(context('resident', residents[0]?.userId ?? '', null)),
  };
}

async function periodWith(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
  amount: number,
) {
  const period = await openUtilityPeriod(fixture.admin, fixture.houseA, OCTOBER, { executor: tx });

  await addPeriodLine(
    fixture.admin,
    period.id,
    { title: 'Электричество', amount },
    { executor: tx },
  );

  return period;
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

describe('распределение периода', () => {
  it('пример 4.1: 30 000 на 10/20/30 дней — 5 000 / 10 000 / 15 000, излишек 0', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9901');
      const period = await periodWith(tx, fixture, 30_000);

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });

      expect(view.total).toBe(30_000);
      expect(view.preview.allocations.map((row) => row.days)).toEqual([10, 20, 30]);
      expect(view.preview.allocations.map((row) => row.amount)).toEqual([5_000, 10_000, 15_000]);
      expect(view.preview.surplus).toBe(0);
    });
  });

  it('пример 4.2: 11/20/30 дней дают 5410 / 9837 / 14755 и излишек 2', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9902', ['2026-10-21', '2026-10-12', '2026-10-02']);
      const period = await periodWith(tx, fixture, 30_000);

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });

      expect(view.preview.allocations.map((row) => row.amount)).toEqual([5_410, 9_837, 14_755]);
      expect(view.preview.surplus).toBe(2);
    });
  });

  it('предварительное распределение ничего не записывает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9903');
      const period = await periodWith(tx, fixture, 30_000);

      await readUtilityPeriod(fixture.admin, period.id, { executor: tx });

      const allocations = await tx
        .select()
        .from(schema.utilityAllocations)
        .where(eq(schema.utilityAllocations.periodId, period.id));

      expect(allocations).toEqual([]);
    });
  });
});

describe('закрытие периода', () => {
  it('фиксирует снимок распределения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9910');
      const period = await periodWith(tx, fixture, 30_000);

      const closed = await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      expect(closed.period.status).toBe('closed');
      expect(closed.allocations).toHaveLength(3);

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      expect(view.allocations.map((row) => row.amount)).toEqual([5_000, 10_000, 15_000]);
    });
  });

  it('дописывает строку в уже выставленный ноябрьский счёт (§4)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9911');
      const period = await periodWith(tx, fixture, 30_000);

      const invoice = await createInvoice(
        fixture.admin,
        {
          residencyId: fixture.residents[0]?.residencyId ?? '',
          type: 'monthly',
          periodMonth: NOVEMBER,
          lines: [{ kind: 'rent', title: 'Проживание', amount: 90_000 }],
        },
        { executor: tx, today: IN_NOVEMBER },
      );

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      const view = await readInvoice(fixture.admin, invoice.id, { executor: tx });

      expect(view.invoice.total).toBe(95_000);
      expect(view.lines.map((line) => line.kind)).toContain('utilities');
    });
  });

  it('без ноябрьского счёта доля ждёт генерации 1 числа', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9912');
      const period = await periodWith(tx, fixture, 30_000);

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: parseBusinessDate('2026-10-31'),
        instant: parseInstant('2026-10-31T11:00:00+05:00'),
      });

      await generateMonthlyInvoices({
        executor: tx,
        instant: parseInstant('2026-10-31T19:30:00Z'),
      });

      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.residencyId, fixture.residents[0]?.residencyId ?? ''));

      expect(invoice?.periodMonth).toBe('2026-11-01');
      expect(invoice?.total).toBe(95_000);
    });
  });

  it('излишек округления переводится в фонд дома (§4.2)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9913', ['2026-10-21', '2026-10-12', '2026-10-02']);
      const period = await periodWith(tx, fixture, 30_000);

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      const lines = await ledgerOf(tx, fixture.orgId);

      expect(lines).toContainEqual({ code: 'utility_fund', direction: 'debit', amount: 2 });
      expect(lines).toContainEqual({
        code: `house_fund:${fixture.houseSlugA}`,
        direction: 'credit',
        amount: 2,
      });
    });
  });

  it('строки закрытого периода не правятся', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9914');
      const period = await periodWith(tx, fixture, 30_000);

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      await expect(
        addPeriodLine(fixture.admin, period.id, { title: 'Вода', amount: 1_000 }, { executor: tx }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('дважды закрыть период нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9915');
      const period = await periodWith(tx, fixture, 30_000);

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      await expect(
        closeUtilityPeriod(fixture.admin, period.id, {
          executor: tx,
          today: IN_NOVEMBER,
          instant: INSTANT,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('период без строк не закрывается: делить нечего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9916');
      const period = await openUtilityPeriod(fixture.admin, fixture.houseA, OCTOBER, {
        executor: tx,
      });

      await expect(
        closeUtilityPeriod(fixture.admin, period.id, {
          executor: tx,
          today: IN_NOVEMBER,
          instant: INSTANT,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

describe('переоткрытие', () => {
  it('доступно только суперадмину', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9920');
      const period = await periodWith(tx, fixture, 30_000);

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      await expect(
        reopenUtilityPeriod(fixture.admin, period.id, { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('стирает снимок и пишет запись в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9921');
      const period = await periodWith(tx, fixture, 30_000);

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });
      const reopened = await reopenUtilityPeriod(fixture.superadmin, period.id, {
        executor: tx,
        instant: INSTANT,
      });

      expect(reopened.status).toBe('draft');

      const allocations = await tx
        .select()
        .from(schema.utilityAllocations)
        .where(eq(schema.utilityAllocations.periodId, period.id));
      expect(allocations).toEqual([]);

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, period.id));
      expect(entries.map((entry) => entry.action)).toContain('utility_period.reopened');
    });
  });
});

describe('область видимости', () => {
  it('админ не ведёт коммуналку чужого дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9930');

      await expect(
        openUtilityPeriod(fixture.adminOfB, fixture.houseA, OCTOBER, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('жилец период не ведёт: свою долю он видит строкой счёта', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9931');

      await expect(
        openUtilityPeriod(fixture.resident, fixture.houseA, OCTOBER, { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('строка удаляется, пока период открыт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9932');
      const period = await periodWith(tx, fixture, 30_000);

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      await removePeriodLine(fixture.admin, view.lines[0]?.id ?? '', { executor: tx });

      const after = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      expect(after.lines).toEqual([]);
      expect(after.total).toBe(0);
    });
  });
});
