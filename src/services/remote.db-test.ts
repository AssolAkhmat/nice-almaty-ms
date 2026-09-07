import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { createInvoice, recordPayment } from './invoices';
import { listRemoteTasks, markInvoiceSent } from './remote';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * «Удалёнка» (§3.1, модуль 2).
 *
 * Список — не отдельная сущность, а вопрос к уже существующим счетам:
 * кому нужно отправить счёт в Kaspi и от кого ждать перевода. Проверяется,
 * что в него попадают ровно те, кто выбрал Kaspi, и что отметка отправки
 * не притворяется оплатой.
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

const MONTH = parseBusinessDate('2026-10-01');
const TODAY = parseBusinessDate('2026-10-05');
const INSTANT = parseInstant('2026-10-05T11:00:00+05:00');
const RENT = 90_000;

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rem-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const slug = `rem-a-${suffix}`;
  const [house] = await tx.insert(schema.houses).values({ orgId, name: 'Дом A', slug }).returning();
  const houseId = house?.id ?? '';

  await seedChartOfAccounts(tx, orgId, [{ id: houseId, slug, name: 'Дом A' }]);

  async function resident(index: number, payment: 'kaspi' | 'cash' | null) {
    const [user] = await tx
      .insert(schema.users)
      .values({
        orgId,
        phone: `+7741${index}${suffix}`,
        passwordHash: 'x',
        role: 'resident',
      })
      .returning();

    await tx.insert(schema.residentProfiles).values({
      userId: user?.id ?? '',
      firstName: `Жилец ${String(index)}`,
      preferredPayment: payment,
    });

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

    return { userId: user?.id ?? '', residencyId: residency?.id ?? '' };
  }

  const kaspi = await resident(1, 'kaspi');
  const cash = await resident(2, 'cash');
  const unset = await resident(3, null);

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7742${suffix}`, passwordHash: 'x', role: 'admin', houseId })
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
    kaspi,
    cash,
    unset,
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    resident: actor(context('resident', kaspi.userId, null)),
  };
}

async function monthlyFor(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
  residencyId: string,
) {
  return createInvoice(
    fixture.admin,
    {
      residencyId,
      type: 'monthly',
      periodMonth: MONTH,
      lines: [{ kind: 'rent', title: 'Проживание', amount: RENT }],
    },
    { executor: tx, today: TODAY },
  );
}

describe('список удалёнки', () => {
  it('в список попадает только тот, кто платит через Kaspi (§3.1)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9001');

      const kaspi = await monthlyFor(tx, fixture, fixture.kaspi.residencyId);
      await monthlyFor(tx, fixture, fixture.cash.residencyId);
      await monthlyFor(tx, fixture, fixture.unset.residencyId);

      const tasks = await listRemoteTasks(
        fixture.admin,
        { houseId: fixture.houseId, periodMonth: MONTH },
        { executor: tx, today: TODAY },
      );

      expect(tasks.map((task) => task.invoice.id)).toEqual([kaspi.id]);
      expect(tasks[0]?.remaining).toBe(RENT);
      expect(tasks[0]?.sent).toBe(false);
    });
  });

  it('оплаченный счёт из списка уходит: перевода ждать больше нечего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9002');
      const invoice = await monthlyFor(tx, fixture, fixture.kaspi.residencyId);

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: RENT, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const tasks = await listRemoteTasks(
        fixture.admin,
        { houseId: fixture.houseId, periodMonth: MONTH },
        { executor: tx, today: TODAY },
      );

      expect(tasks).toEqual([]);
    });
  });

  it('частично оплаченный счёт остаётся: остаток ещё ждут', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9003');
      const invoice = await monthlyFor(tx, fixture, fixture.kaspi.residencyId);

      await recordPayment(
        fixture.admin,
        invoice.id,
        { amount: 30_000, method: 'kaspi' },
        { executor: tx, today: TODAY },
      );

      const tasks = await listRemoteTasks(
        fixture.admin,
        { houseId: fixture.houseId, periodMonth: MONTH },
        { executor: tx, today: TODAY },
      );

      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.remaining).toBe(60_000);
    });
  });

  it('отменённый счёт в список не попадает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9004');
      const invoice = await monthlyFor(tx, fixture, fixture.kaspi.residencyId);

      await tx
        .update(schema.invoices)
        .set({ status: 'cancelled' })
        .where(eq(schema.invoices.id, invoice.id));

      const tasks = await listRemoteTasks(
        fixture.admin,
        { houseId: fixture.houseId, periodMonth: MONTH },
        { executor: tx, today: TODAY },
      );

      expect(tasks).toEqual([]);
    });
  });

  /*
   * Счета жилец читать вправе — свои (P1-1). Дом целиком в его область
   * видимости не входит, поэтому ответ 404, а не 403: иначе перебором
   * идентификаторов домов узнавался бы состав сети.
   */
  it('дом целиком жильцу не виден: 404, а не 403', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9005');

      await expect(
        listRemoteTasks(
          fixture.resident,
          { houseId: fixture.houseId },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('отметка «счёт отправлен»', () => {
  it('запоминает момент отправки и не трогает статус счёта', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9010');
      const invoice = await monthlyFor(tx, fixture, fixture.kaspi.residencyId);

      const sent = await markInvoiceSent(fixture.admin, invoice.id, {
        executor: tx,
        instant: INSTANT,
      });

      expect(sent.remoteSentAt).not.toBeNull();
      expect(sent.status).toBe('issued');

      const [task] = await listRemoteTasks(
        fixture.admin,
        { houseId: fixture.houseId, periodMonth: MONTH },
        { executor: tx, today: TODAY },
      );
      expect(task?.sent).toBe(true);
    });
  });

  it('дважды отправленным счёт не помечается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9011');
      const invoice = await monthlyFor(tx, fixture, fixture.kaspi.residencyId);

      await markInvoiceSent(fixture.admin, invoice.id, { executor: tx, instant: INSTANT });

      await expect(
        markInvoiceSent(fixture.admin, invoice.id, { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('отменённый счёт не отправляется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9012');
      const invoice = await monthlyFor(tx, fixture, fixture.kaspi.residencyId);

      await tx
        .update(schema.invoices)
        .set({ status: 'cancelled' })
        .where(eq(schema.invoices.id, invoice.id));

      await expect(
        markInvoiceSent(fixture.admin, invoice.id, { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});
