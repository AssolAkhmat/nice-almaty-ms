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
