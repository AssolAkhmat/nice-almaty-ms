import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

import { grantFileView } from './files';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { createInvoice, readInvoice } from './invoices';
import { generateMonthlyInvoices } from './monthly-invoices';
import {
  addPeriodLine,
  closeUtilityPeriod,
  correctUtilityDays,
  listUtilityReceiptsFor,
  findPeriodOfMonth,
  listPeriodsOfHouse,
  openUtilityPeriod,
  previewDayCorrection,
  readUtilityHistory,
  readUtilityPeriod,
  readUtilityShareFor,
  removePeriodLine,
  reopenUtilityPeriod,
  setHouseDays,
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

/** Текст отказа вместе с причиной: имя ограничения базы лежит в `cause`. */
function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }

  return parts.join(' | ');
}

async function failureText(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
  } catch (error) {
    return errorChain(error);
  }

  throw new Error('Ожидался отказ, но действие прошло');
}

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
      houseId: houseId,
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
    /* Жилец без проживания в этом доме: чек дома ему не положен. */
    foreignResident: actor(context('resident', superUser?.id ?? '', null)),
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

  /*
   * Дом мог за месяц не платить вовсе (указание владельца, 22 сентября 2026).
   * Раньше такой период не закрывался, и прошлые месяцы оставались висеть
   * незакрытыми навсегда.
   */
  it('период без строк закрывается: ноль — это тоже итог месяца', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9916');
      const period = await openUtilityPeriod(fixture.admin, fixture.houseA, OCTOBER, {
        executor: tx,
      });

      const closed = await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      expect(closed.period.status).toBe('closed');
      // Снимок есть, и он честный: три жильца, у каждого ноль.
      expect(closed.allocations).toHaveLength(3);
      expect(closed.allocations.map((row) => row.amount)).toEqual([0, 0, 0]);
    });
  });

  it('нулевой период не дописывает в счёт строку на ноль тенге', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9926');
      const period = await openUtilityPeriod(fixture.admin, fixture.houseA, OCTOBER, {
        executor: tx,
      });

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

      const closed = await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      expect(closed.invoiced).toBe(0);

      const view = await readInvoice(fixture.admin, invoice.id, { executor: tx });

      expect(view.invoice.total).toBe(90_000);
      expect(view.lines.map((line) => line.kind)).not.toContain('utilities');
    });
  });

  /*
   * Сумма, которую не на кого разложить, — по-прежнему отказ: она потерялась
   * бы молча. Отличие от нулевого периода в том, что делить там нечего,
   * а здесь есть что.
   */
  it('сумма без единого жильца месяца не закрывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9936', ['2026-12-01']);
      const period = await openUtilityPeriod(fixture.admin, fixture.houseA, OCTOBER, {
        executor: tx,
      });

      await addPeriodLine(
        fixture.admin,
        period.id,
        { title: 'Свет', amount: 30_000 },
        { executor: tx },
      );

      await expect(
        closeUtilityPeriod(fixture.admin, period.id, {
          executor: tx,
          today: IN_NOVEMBER,
          instant: INSTANT,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('период заводится за любой месяц, включая текущий и давно прошедший', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9946');

      for (const month of ['2026-09-01', '2025-01-01', '2026-12-01'] as const) {
        const period = await openUtilityPeriod(
          fixture.admin,
          fixture.houseA,
          parseBusinessDate(month),
          { executor: tx },
        );

        expect(period.month).toBe(month);
      }

      const months = (
        await listPeriodsOfHouse(fixture.admin, fixture.houseA, { executor: tx })
      ).map((period) => period.month);

      expect(months).toEqual(['2026-12-01', '2026-09-01', '2025-01-01']);
    });
  });

  it('показ месяца ничего не создаёт: черновик заводится только действием', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9956');

      expect(
        await findPeriodOfMonth(fixture.admin, fixture.houseA, OCTOBER, { executor: tx }),
      ).toBeNull();

      await openUtilityPeriod(fixture.admin, fixture.houseA, OCTOBER, { executor: tx });

      expect(
        await findPeriodOfMonth(fixture.admin, fixture.houseA, OCTOBER, { executor: tx }),
      ).not.toBeNull();
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

/**
 * История коммуналки по дому (модуль 6, «Отчёты»): месяц, сумма, средняя
 * доля, число жильцов и дней. Считается по снимку закрытого периода —
 * открытый ещё меняется, и в отчёте ему делать нечего.
 */
describe('история по дому', () => {
  it('показывает сумму, число жильцов, дней и среднюю долю', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9940');
      const period = await periodWith(tx, fixture, 30_000);

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      const history = await readUtilityHistory(fixture.admin, fixture.houseA, { executor: tx });

      expect(history).toHaveLength(1);
      expect(history[0]?.month).toBe('2026-10-01');
      expect(history[0]?.total).toBe(30_000);
      expect(history[0]?.participants).toBe(3);
      expect(history[0]?.days).toBe(60);
      // 30 000 на троих — в среднем 10 000 на человека.
      expect(history[0]?.averageShare).toBe(10_000);
    });
  });

  it('открытый период в отчёт не попадает: его доли ещё меняются', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9941');
      await periodWith(tx, fixture, 30_000);

      expect(await readUtilityHistory(fixture.admin, fixture.houseA, { executor: tx })).toEqual([]);
    });
  });

  it('чужой дом в отчёт не отдаётся', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9942');

      await expect(
        readUtilityHistory(fixture.adminOfB, fixture.houseA, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

/*
 * Чек коммуналки жильцу (указание владельца, 25 сентября 2026): в счёте
 * есть строка, пусть будет видно и основание. Граница: только закрытый
 * период и только свой дом.
 */
describe('чек коммуналки у жильца', () => {
  async function periodWithReceipt(tx: Transaction, tag: string) {
    const fixture = await seed(tx, tag);

    const [file] = await tx
      .insert(schema.files)
      .values({
        orgId: fixture.orgId,
        houseId: fixture.houseA,
        provider: 'local',
        path: `utl-${tag}/чек`,
        mime: 'image/jpeg',
        sizeBytes: 1024,
        originalName: 'свет.jpg',
        status: 'ready',
        uploadedBy: fixture.admin.context.userId,
        scope: { purpose: 'utility-receipt' },
      })
      .returning();

    const fileId = file?.id ?? '';

    const period = await openUtilityPeriod(fixture.admin, fixture.houseA, OCTOBER, {
      executor: tx,
    });

    await addPeriodLine(
      fixture.admin,
      period.id,
      { title: 'Свет', amount: 30_000, receiptFileId: fileId },
      { executor: tx },
    );

    return { fixture, fileId, periodId: period.id };
  }

  it('у открытого периода чек жильцу не отдаётся: расчёт ещё меняется', async () => {
    await inRollback(async (tx) => {
      const { fixture, fileId } = await periodWithReceipt(tx, '9960');

      await expect(
        grantFileView(fixture.resident, fileId, 'inline', { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('у закрытого периода своего дома чек открывается', async () => {
    await inRollback(async (tx) => {
      const { fixture, fileId, periodId } = await periodWithReceipt(tx, '9961');

      await closeUtilityPeriod(fixture.admin, periodId, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      const grant = await grantFileView(fixture.resident, fileId, 'inline', { executor: tx });

      expect(grant).toContain('inline');

      const receipts = await listUtilityReceiptsFor(
        fixture.resident,
        { userId: fixture.resident.context.userId, month: OCTOBER },
        { executor: tx },
      );

      expect(receipts).toEqual([{ fileId, title: 'Свет' }]);
    });
  });

  it('жильцу чужого дома чек не отдаётся', async () => {
    await inRollback(async (tx) => {
      const { fixture, fileId, periodId } = await periodWithReceipt(tx, '9962');

      await closeUtilityPeriod(fixture.admin, periodId, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      await expect(
        grantFileView(fixture.foreignResident, fileId, 'inline', { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

/**
 * Ручная корректировка человеко-дней (P2-6, указание владельца
 * 27 сентября 2026).
 *
 * Фикстура та же, что у примера §4.1: сутки 10 / 20 / 30 при итоге 30 000.
 * Каждый тест здесь падал бы до появления корректировки — потому что
 * поставить своё число суток было нечем.
 */
describe('корректировка человеко-дней', () => {
  const REASON = 'Каникулы: уехал, отсутствие не оформлял';

  it('уменьшение проходит и меняет деньги по скорректированным суткам', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9970');
      const period = await periodWith(tx, fixture, 30_000);

      /* Третий жилец прожил 30 суток из 60; ставим 10 — знаменатель станет 40. */
      await correctUtilityDays(
        fixture.admin,
        {
          periodId: period.id,
          userId: fixture.residents[2]?.userId ?? '',
          days: 10,
          comment: REASON,
          confirmIncrease: false,
        },
        { executor: tx },
      );

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });

      expect(view.preview.allocations.map((row) => row.days)).toEqual([10, 10, 20]);
      expect(view.preview.allocations.map((row) => row.amount)).toEqual([7_500, 7_500, 15_000]);
      expect(view.preview.surplus).toBe(0);
    });
  });

  it('исходное расчётное значение читается после правки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9971');
      const period = await periodWith(tx, fixture, 30_000);
      const userId = fixture.residents[2]?.userId ?? '';

      await correctUtilityDays(
        fixture.admin,
        { periodId: period.id, userId, days: 10, comment: REASON, confirmIncrease: false },
        { executor: tx },
      );

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      const row = view.participants.find((entry) => entry.userId === userId);

      expect(row?.systemDays).toBe(30);
      expect(row?.days).toBe(10);
      expect(row?.adjustment?.systemDays).toBe(30);
      expect(row?.adjustment?.comment).toBe(REASON);
    });
  });

  it('без комментария отказ', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9972');
      const period = await periodWith(tx, fixture, 30_000);

      await expect(
        correctUtilityDays(
          fixture.admin,
          {
            periodId: period.id,
            userId: fixture.residents[2]?.userId ?? '',
            days: 10,
            comment: '   ',
            confirmIncrease: false,
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('увеличение без подтверждения отказ, с подтверждением проходит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9973');
      const period = await periodWith(tx, fixture, 30_000);
      const userId = fixture.residents[0]?.userId ?? '';

      const input = {
        periodId: period.id,
        userId,
        days: 20,
        comment: 'Жил весь месяц, заезд оформлен позже',
      };

      await expect(
        correctUtilityDays(fixture.admin, { ...input, confirmIncrease: false }, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);

      await correctUtilityDays(
        fixture.admin,
        { ...input, confirmIncrease: true },
        { executor: tx },
      );

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });

      expect(view.participants.find((entry) => entry.userId === userId)?.days).toBe(20);
    });
  });

  it('в журнале оба значения: расчётное и поставленное', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9974');
      const period = await periodWith(tx, fixture, 30_000);

      await correctUtilityDays(
        fixture.admin,
        {
          periodId: period.id,
          userId: fixture.residents[2]?.userId ?? '',
          days: 10,
          comment: REASON,
          confirmIncrease: false,
        },
        { executor: tx },
      );

      const [entry] = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'utility_days.corrected'));

      expect(entry?.before).toMatchObject({ days: 30, systemDays: 30 });
      expect(entry?.after).toMatchObject({ days: 10, comment: REASON });
    });
  });

  it('пересчёт до сохранения ничего не пишет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9975');
      const period = await periodWith(tx, fixture, 30_000);
      const userId = fixture.residents[2]?.userId ?? '';

      const preview = await previewDayCorrection(
        fixture.admin,
        period.id,
        { userId, days: 10 },
        { executor: tx },
      );

      expect(preview.distribution.allocations.map((row) => row.amount)).toEqual([
        7_500, 7_500, 15_000,
      ]);

      const saved = await tx
        .select()
        .from(schema.utilityDayAdjustments)
        .where(eq(schema.utilityDayAdjustments.periodId, period.id));

      expect(saved).toEqual([]);

      /* А сам период после предпросмотра считается по-прежнему. */
      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });

      expect(view.preview.allocations.map((row) => row.days)).toEqual([10, 20, 30]);
    });
  });

  it('закрытый период правку не принимает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9976');
      const period = await periodWith(tx, fixture, 30_000);

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      await expect(
        correctUtilityDays(
          fixture.admin,
          {
            periodId: period.id,
            userId: fixture.residents[2]?.userId ?? '',
            days: 10,
            comment: REASON,
            confirmIncrease: false,
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('корректировка уходит в счёт и в раскладку жильца', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9977');
      const period = await periodWith(tx, fixture, 30_000);
      const userId = fixture.residents[2]?.userId ?? '';

      await correctUtilityDays(
        fixture.admin,
        { periodId: period.id, userId, days: 10, comment: REASON, confirmIncrease: false },
        { executor: tx },
      );

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      const share = await readUtilityShareFor(
        fixture.admin,
        { userId, month: OCTOBER },
        { executor: tx },
      );

      /* Жильцу видно, по какому числу суток посчитано (Приложение №3 п. 4.4). */
      expect(share).toMatchObject({ days: 10, totalDays: 40, amount: 7_500, total: 30_000 });
    });
  });

  it('жилец без суток в доме правке не подлежит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9978');
      const period = await periodWith(tx, fixture, 30_000);

      await expect(
        correctUtilityDays(
          fixture.admin,
          {
            periodId: period.id,
            userId: fixture.superadmin.context.userId,
            days: 10,
            comment: REASON,
            confirmIncrease: false,
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  /*
   * Негативные фикстуры на запреты самой базы: сервис их соблюдает, но
   * вставок в таблицу со временем станет больше одной. Оба теста краснеют,
   * если CHECK из схемы убрать.
   */
  it('база не принимает корректировку без комментария', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9980');
      const period = await periodWith(tx, fixture, 30_000);

      const message = await failureText(() =>
        tx.insert(schema.utilityDayAdjustments).values({
          periodId: period.id,
          userId: fixture.residents[2]?.userId ?? '',
          systemDays: 30,
          days: 10,
          comment: '   ',
          createdBy: fixture.admin.context.userId,
        }),
      );

      expect(message).toContain('utility_day_adjustments_comment_present');
    });
  });

  it('база не принимает отрицательные сутки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9981');
      const period = await periodWith(tx, fixture, 30_000);

      const message = await failureText(() =>
        tx.insert(schema.utilityDayAdjustments).values({
          periodId: period.id,
          userId: fixture.residents[2]?.userId ?? '',
          systemDays: 30,
          days: -1,
          comment: 'минус суток не бывает',
          createdBy: fixture.admin.context.userId,
        }),
      );

      expect(message).toContain('utility_day_adjustments_days_non_negative');
    });
  });

  it('админ чужого дома править не может', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9979');
      const period = await periodWith(tx, fixture, 30_000);

      await expect(
        correctUtilityDays(
          fixture.adminOfB,
          {
            periodId: period.id,
            userId: fixture.residents[2]?.userId ?? '',
            days: 10,
            comment: REASON,
            confirmIncrease: false,
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

/**
 * Доля дома в коммуналке (P2-7, указание владельца 27 сентября 2026).
 *
 * Фикстура та же: сутки 10 / 20 / 30, итог 30 000. Арифметика доказана
 * числами в ядре, здесь — что доля дома доезжает до проводки, до снимка
 * и до раскладки жильца, а в счета не попадает.
 */
describe('доля дома', () => {
  const REASON = 'Отопление общих помещений и два пустых места';

  it('по умолчанию ноль: расчёт совпадает с прежним', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9990');
      const period = await periodWith(tx, fixture, 30_000);

      expect(period.houseDays).toBe(0);

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });

      expect(view.preview.allocations.map((row) => row.amount)).toEqual([5_000, 10_000, 15_000]);
      expect(view.preview.house).toEqual({ days: 0, amount: 0 });
    });
  });

  it('человеко-дни дома уменьшают долю каждого жильца', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9991');
      const period = await periodWith(tx, fixture, 30_000);

      await setHouseDays(fixture.admin, period.id, { days: 12, comment: REASON }, { executor: tx });

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      const amounts = view.preview.allocations.map((row) => row.amount);

      expect(amounts[0]).toBeLessThan(5_000);
      expect(amounts[1]).toBeLessThan(10_000);
      expect(amounts[2]).toBeLessThan(15_000);

      /* Деньги периода сходятся: доля дома и излишек лежат на счёте дома. */
      const residents = amounts.reduce((sum, amount) => sum + amount, 0);

      expect(residents + view.preview.house.amount - view.preview.surplus).toBe(30_000);
    });
  });

  it('без причины ненулевая доля дома не сохраняется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9992');
      const period = await periodWith(tx, fixture, 30_000);

      await expect(
        setHouseDays(fixture.admin, period.id, { days: 12, comment: '  ' }, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('отрицательная доля дома отклоняется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9993');
      const period = await periodWith(tx, fixture, 30_000);

      await expect(
        setHouseDays(fixture.admin, period.id, { days: -1, comment: REASON }, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('база не принимает ненулевую долю дома без причины', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9994');
      const period = await periodWith(tx, fixture, 30_000);

      const message = await failureText(() =>
        tx
          .update(schema.utilityPeriods)
          .set({ houseDays: 12, houseDaysComment: null })
          .where(eq(schema.utilityPeriods.id, period.id)),
      );

      expect(message).toContain('utility_periods_house_days_comment');
    });
  });

  it('сумма доли дома уходит на счёт дома, а не в счета жильцов', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9995');
      const period = await periodWith(tx, fixture, 30_000);

      await setHouseDays(fixture.admin, period.id, { days: 12, comment: REASON }, { executor: tx });

      /* Счета ноября выставлены заранее — доли лягут в них строками. */
      await generateMonthlyInvoices({
        executor: tx,
        instant: parseInstant('2026-10-31T19:30:00Z'),
      });

      const closed = await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      /* Снимок несёт сумму доли дома: пересчитывать её потом нечем. */
      expect(closed.period.houseAmount).toBe(5_000);

      const lines = await ledgerOf(tx, fixture.orgId);
      const houseShare = lines.filter((line) => line.amount === 5_000);

      expect(houseShare).toEqual(
        expect.arrayContaining([
          { code: `house_fund:${fixture.houseSlugA}`, direction: 'debit', amount: 5_000 },
          { code: 'utility_fund', direction: 'credit', amount: 5_000 },
        ]),
      );

      /* В счетах жильцов доли дома нет: сумма строк — только их доли. */
      const invoiceLines = await tx
        .select({ amount: schema.invoiceLines.amount, kind: schema.invoiceLines.kind })
        .from(schema.invoiceLines);

      const utilities = invoiceLines.filter((line) => line.kind === 'utilities');

      expect(utilities.reduce((sum, line) => sum + line.amount, 0)).toBe(
        closed.allocations.reduce((sum, row) => sum + row.amount, 0),
      );
      expect(utilities.some((line) => line.amount === 5_000)).toBe(false);
    });
  });

  it('жильцу видно долю дома отдельной строкой раскладки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9996');
      const period = await periodWith(tx, fixture, 30_000);

      await setHouseDays(fixture.admin, period.id, { days: 12, comment: REASON }, { executor: tx });

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      const share = await readUtilityShareFor(
        fixture.admin,
        { userId: fixture.residents[0]?.userId ?? '', month: OCTOBER },
        { executor: tx },
      );

      /* Знаменатель включает сутки дома: 10 + 20 + 30 + 12. */
      expect(share).toMatchObject({ days: 10, totalDays: 72, houseDays: 12, houseAmount: 5_000 });
    });
  });

  it('переоткрытие отменяет проводки периода, повторное закрытие не удваивает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9997');
      const period = await periodWith(tx, fixture, 30_000);

      await setHouseDays(fixture.admin, period.id, { days: 12, comment: REASON }, { executor: tx });

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      await reopenUtilityPeriod(fixture.superadmin, period.id, { executor: tx });

      await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      /*
       * После сторно и повторного закрытия проводок ровно по одной: доля
       * дома и излишек округления. Без отмены их было бы по две — до доли
       * дома тем же путём удваивался излишек, и увидеть это было нечем.
       */
      const entries = await tx
        .select({
          id: schema.ledgerEntries.id,
          description: schema.ledgerEntries.description,
          reversed: schema.ledgerEntries.reversedByEntryId,
        })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.sourceId, period.id));

      const active = entries.filter(
        (entry) => entry.reversed === null && !entry.description.startsWith('Сторно'),
      );

      expect(active.map((entry) => entry.description).sort()).toEqual([
        'Доля дома в коммуналке',
        'Излишек округления коммуналки',
      ]);
    });
  });

  it('месяц без жильцов с долей дома закрывается: платит дом', async () => {
    await inRollback(async (tx) => {
      /* Заезды в ноябре: в октябре в доме не жил никто. */
      const fixture = await seed(tx, '9998', ['2026-11-02', '2026-11-03', '2026-11-04']);
      const period = await periodWith(tx, fixture, 30_000);

      await setHouseDays(
        fixture.admin,
        period.id,
        { days: 30, comment: 'Дом стоял пустым, отопление шло' },
        { executor: tx },
      );

      const closed = await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: IN_NOVEMBER,
        instant: INSTANT,
      });

      expect(closed.allocations).toEqual([]);
      expect(closed.period.houseAmount).toBe(30_000);
    });
  });

  it('месяц без жильцов и без доли дома закрыть нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9999', ['2026-11-02', '2026-11-03', '2026-11-04']);
      const period = await periodWith(tx, fixture, 30_000);

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

/**
 * Участие в раскладке — по занятости места, а не по роли (указание владельца,
 * 30 сентября 2026).
 *
 * На боевой админ дома с местом с 22 августа выпадал из сентябрьской
 * раскладки: у его проживания статус `created` и пустая дата заселения,
 * а сутки считались от даты заселения. Его потребление раскладывалось
 * на жильцов — они переплачивали.
 *
 * Каждая проверка ниже падала бы до этой правки.
 */
describe('роль и занятость места ортогональны', () => {
  /** Место админу: своя комната, своё место, назначение на весь октябрь. */
  async function placeAdmin(
    tx: Transaction,
    fixture: Awaited<ReturnType<typeof seed>>,
    suffix: string,
  ): Promise<string> {
    const [area] = await tx
      .insert(schema.areas)
      .values({ houseId: fixture.houseA, name: `Комната админа ${suffix}`, type: 'living' })
      .returning();

    const [bed] = await tx
      .insert(schema.beds)
      .values({
        houseId: fixture.houseA,
        areaId: area?.id ?? '',
        number: 9,
        tier: 'lower',
        label: `9 низ ${suffix}`,
        /* У админа цена обычно ноль: он не платит за место, но платит коммуналку. */
        defaultPrice: 0,
      })
      .returning();

    /*
     * Проживание админа заведено вместе с учётной записью (P9-3): статус
     * `created`, даты заселения нет — ровно как на боевой.
     */
    const [residency] = await tx
      .insert(schema.residencies)
      .values({
        orgId: fixture.orgId,
        userId: fixture.admin.context.userId,
        houseId: fixture.houseA,
        status: 'created',
      })
      .returning();

    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId: bed?.id ?? '',
      houseId: fixture.houseA,
      price: 0,
      period: '[2026-09-20,)',
    });

    return residency?.id ?? '';
  }

  it('админ с назначенным местом попадает в раскладку за период', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9810');
      await placeAdmin(tx, fixture, '9810');
      const period = await periodWith(tx, fixture, 30_000);

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      const adminRow = view.participants.find((row) => row.userId === fixture.admin.context.userId);

      /* Октябрь занят целиком: назначение открыто с 20 сентября. */
      expect(adminRow?.systemDays).toBe(31);
      expect(view.preview.allocations.map((row) => row.userId)).toContain(
        fixture.admin.context.userId,
      );
    });
  });

  it('админ без назначенного места в раскладку не попадает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9811');
      const period = await periodWith(tx, fixture, 30_000);

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });

      expect(view.participants.map((row) => row.userId)).not.toContain(
        fixture.admin.context.userId,
      );
      /* Знаменатель — только жильцы: 10 + 20 + 31 суток занятости. */
      expect(view.preview.allocations).toHaveLength(3);
    });
  });

  it('с включением админа доля каждого жильца строго уменьшается', async () => {
    await inRollback(async (tx) => {
      const without = await seed(tx, '9812');
      const before = await readUtilityPeriod(
        without.admin,
        (await periodWith(tx, without, 30_000)).id,
        { executor: tx },
      );

      const with_ = await seed(tx, '9813');
      await placeAdmin(tx, with_, '9813');
      const after = await readUtilityPeriod(with_.admin, (await periodWith(tx, with_, 30_000)).id, {
        executor: tx,
      });

      const shareOf = (
        view: Awaited<ReturnType<typeof readUtilityPeriod>>,
        index: number,
      ): number => view.preview.allocations[index]?.amount ?? 0;

      /* Те же три жильца с теми же сутками — и у каждого доля меньше. */
      for (const index of [0, 1, 2]) {
        expect(shareOf(after, index)).toBeLessThan(shareOf(before, index));
      }

      const total = after.preview.allocations.reduce((sum, row) => sum + row.amount, 0);

      expect(after.preview.allocations).toHaveLength(4);
      expect(total + after.preview.surplus).toBeGreaterThanOrEqual(30_000);
    });
  });

  it('жилец без даты заселения платит за занятые сутки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9814');

      /* Ровно случай Хусаин Даны с боевой: место есть, даты заселения нет. */
      await tx
        .update(schema.residencies)
        .set({ moveInDate: null, status: 'created' })
        .where(eq(schema.residencies.id, fixture.residents[2]?.residencyId ?? ''));

      const period = await periodWith(tx, fixture, 30_000);
      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      const row = view.participants.find((entry) => entry.userId === fixture.residents[2]?.userId);

      expect(row?.systemDays).toBe(30);
    });
  });
});
