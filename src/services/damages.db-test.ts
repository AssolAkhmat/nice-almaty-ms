import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { createDamage, listHouseDamages, previewDamage, reverseDamage } from './damages';
import { readDepositView } from './deposits';
import { createRefundInvoice, terminateResidency } from './terminations';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Ущерб: деление, списание с депозитов и сторно (§8, модуль 7).
 *
 * Арифметика деления проверена числами в `src/domain/damage.test.ts`.
 * Здесь проверяется, что деньги двигаются вместе: доля жильца, движение
 * его депозита и проводка в фонд дома обязаны появиться одной операцией
 * либо не появиться вовсе.
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
const INSTANT = parseInstant('2026-09-15T11:00:00+05:00');
const DEPOSIT = 45_000;

/**
 * Дом с двумя комнатами и `count` жильцами: первая половина в комнате 1,
 * вторая — в комнате 2. У каждого оплаченный депозит: без него списывать
 * было бы не с чего, а §2.4 разрешает уводить остаток в минус.
 */
async function seed(tx: Transaction, suffix: string, count = 4) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `dmg-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const slugA = `dmg-a-${suffix}`;
  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: slugA })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `dmg-b-${suffix}` })
    .returning();
  const houseAId = houseA?.id ?? '';

  await seedChartOfAccounts(tx, orgId, [
    { id: houseAId, slug: slugA, name: 'Дом A' },
    { id: houseB?.id ?? '', slug: `dmg-b-${suffix}`, name: 'Дом B' },
  ]);

  const areaIds: string[] = [];
  for (const name of ['Комната 1', 'Комната 2']) {
    const [area] = await tx
      .insert(schema.areas)
      .values({ houseId: houseAId, name, type: 'living' })
      .returning();
    areaIds.push(area?.id ?? '');
  }

  const residents: { userId: string; residencyId: string; areaId: string }[] = [];

  for (let index = 0; index < count; index += 1) {
    const areaId = areaIds[index < count / 2 ? 0 : 1] ?? '';

    const [user] = await tx
      .insert(schema.users)
      .values({
        orgId,
        phone: `+7708${String(index).padStart(2, '0')}${suffix}`,
        passwordHash: 'x',
        role: 'resident',
      })
      .returning();

    const [residency] = await tx
      .insert(schema.residencies)
      .values({
        orgId,
        userId: user?.id ?? '',
        houseId: houseAId,
        status: 'active',
        moveInDate: '2026-01-01',
      })
      .returning();

    const [bed] = await tx
      .insert(schema.beds)
      .values({
        houseId: houseAId,
        areaId,
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
      period: '[2026-01-01,)',
    });

    await tx.insert(schema.depositTransactions).values({
      orgId,
      residencyId: residency?.id ?? '',
      type: 'charge',
      amount: DEPOSIT,
    });

    residents.push({ userId: user?.id ?? '', residencyId: residency?.id ?? '', areaId });
  }

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7701${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7702${suffix}`,
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
    houseB: houseB?.id ?? '',
    houseSlugA: slugA,
    areaIds,
    residents,
    superadmin: actor(context('superadmin', superUser?.id ?? '', null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseAId)),
    adminOfB: actor(context('admin', adminUser?.id ?? '', houseB?.id ?? '')),
    resident: actor(context('resident', residents[0]?.userId ?? '', null)),
  };
}

async function depositBalanceOf(tx: Transaction, residencyId: string): Promise<number> {
  const rows = await tx
    .select({ amount: schema.depositTransactions.amount })
    .from(schema.depositTransactions)
    .where(eq(schema.depositTransactions.residencyId, residencyId));

  return rows.reduce((sum, row) => sum + row.amount, 0);
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

describe('деление ущерба', () => {
  it('пример 8.1: 1 800 ₸ на 18 из 20 — по 100 ₸, излишек 0', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9601', 20);
      const excluded = fixture.residents.slice(0, 2).map((entry) => entry.userId);

      const damage = await createDamage(
        fixture.admin,
        {
          houseId: fixture.houseA,
          title: 'Ручка в туалете',
          amount: 1_800,
          splitMode: 'all_except',
          userIds: excluded,
        },
        { executor: tx, today: TODAY },
      );

      expect(damage.shares).toHaveLength(18);
      expect(damage.shares.every((share) => share.amount === 100)).toBe(true);
      expect(damage.damage.surplus).toBe(0);

      // Исключённые не платят, участники платят по 100 ₸.
      expect(await depositBalanceOf(tx, fixture.residents[0]?.residencyId ?? '')).toBe(DEPOSIT);
      expect(await depositBalanceOf(tx, fixture.residents[5]?.residencyId ?? '')).toBe(
        DEPOSIT - 100,
      );
    });
  });

  it('излишек округления остаётся в фонде дома, а не теряется (§0, §8)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9602', 17);

      const damage = await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Замок', amount: 1_800, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      // 1800 / 17 = 105,88 → по 106, сумма долей 1802, излишек 2.
      expect(damage.shares.every((share) => share.amount === 106)).toBe(true);
      expect(damage.damage.surplus).toBe(2);

      const lines = await ledgerOf(tx, fixture.orgId);
      expect(lines).toContainEqual({ code: 'deposit_fund', direction: 'debit', amount: 1_802 });
      expect(lines).toContainEqual({
        code: `house_fund:${fixture.houseSlugA}`,
        direction: 'credit',
        amount: 1_802,
      });
    });
  });

  it('режим «по комнате» берёт только жильцов выбранной комнаты', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9603', 4);

      const damage = await createDamage(
        fixture.admin,
        {
          houseId: fixture.houseA,
          title: 'Разбито окно',
          amount: 10_000,
          splitMode: 'room',
          areaId: fixture.areaIds[0] ?? '',
        },
        { executor: tx, today: TODAY },
      );

      const paid = new Set(damage.shares.map((share) => share.userId));

      expect(damage.shares).toHaveLength(2);
      expect(paid.has(fixture.residents[0]?.userId ?? '')).toBe(true);
      expect(paid.has(fixture.residents[3]?.userId ?? '')).toBe(false);
    });
  });

  it('предпросмотр показывает доли и ничего не записывает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9604', 4);

      const preview = await previewDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Стул', amount: 1_000, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      expect(preview.shares).toHaveLength(4);
      expect(preview.charged).toBe(1_000);
      expect(await listHouseDamages(fixture.admin, fixture.houseA, { executor: tx })).toEqual([]);
      expect(await depositBalanceOf(tx, fixture.residents[0]?.residencyId ?? '')).toBe(DEPOSIT);
    });
  });

  it('ущерб уводит депозит в минус — это разрешено (§2.4)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9605', 2);

      await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Дверь', amount: 200_000, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      expect(await depositBalanceOf(tx, fixture.residents[0]?.residencyId ?? '')).toBe(
        DEPOSIT - 100_000,
      );
    });
  });

  it('архивное проживание в делении не участвует: его депозит уже разобран', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9606', 4);

      await tx
        .update(schema.residencies)
        .set({ status: 'archived' })
        .where(eq(schema.residencies.id, fixture.residents[0]?.residencyId ?? ''));

      const damage = await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Плита', amount: 3_000, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      expect(damage.shares).toHaveLength(3);
      expect(damage.shares.every((share) => share.amount === 1_000)).toBe(true);
    });
  });

  it('без участников ущерб не сохраняется: сумма не должна исчезнуть', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9607', 4);

      await expect(
        createDamage(
          fixture.admin,
          {
            houseId: fixture.houseA,
            title: 'Ничей ущерб',
            amount: 1_000,
            splitMode: 'custom',
            userIds: [],
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await listHouseDamages(fixture.admin, fixture.houseA, { executor: tx })).toEqual([]);
    });
  });

  it('нулевая и дробная сумма не принимаются: деньги — целые тенге', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9608', 4);

      for (const amount of [0, 1.5, -100]) {
        await expect(
          createDamage(
            fixture.admin,
            { houseId: fixture.houseA, title: 'Ошибка суммы', amount, splitMode: 'all' },
            { executor: tx, today: TODAY },
          ),
        ).rejects.toBeInstanceOf(ValidationError);
      }
    });
  });
});

describe('область видимости', () => {
  it('админ не заводит ущерб в чужом доме', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9610', 2);

      await expect(
        createDamage(
          fixture.adminOfB,
          { houseId: fixture.houseA, title: 'Чужой дом', amount: 1_000, splitMode: 'all' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('жилец списка ущербов не ведёт: свои списания он видит в депозите', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9611', 2);

      await expect(
        listHouseDamages(fixture.resident, fixture.houseA, { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('сторно ущерба', () => {
  it('админ дома сторнировать не может — только суперадмин (§8)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9620', 2);

      const damage = await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Стол', amount: 2_000, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      await expect(
        reverseDamage(fixture.admin, damage.damage.id, { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('возвращает суммы на депозиты и создаёт обратную проводку', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9621', 2);

      const damage = await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Стол', amount: 2_000, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      expect(await depositBalanceOf(tx, fixture.residents[0]?.residencyId ?? '')).toBe(
        DEPOSIT - 1_000,
      );

      const reversed = await reverseDamage(fixture.superadmin, damage.damage.id, {
        executor: tx,
        instant: INSTANT,
      });

      expect(reversed.reversedAt).not.toBeNull();
      expect(await depositBalanceOf(tx, fixture.residents[0]?.residencyId ?? '')).toBe(DEPOSIT);

      // Оригинал и сторно гасят друг друга, но обе записи остаются в журнале.
      const lines = await ledgerOf(tx, fixture.orgId);
      expect(lines).toHaveLength(4);
      expect(lines.filter((line) => line.code === 'deposit_fund')).toHaveLength(2);
    });
  });

  it('дважды сторнировать один ущерб нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9622', 2);

      const damage = await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Стол', amount: 2_000, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      await reverseDamage(fixture.superadmin, damage.damage.id, {
        executor: tx,
        instant: INSTANT,
      });

      await expect(
        reverseDamage(fixture.superadmin, damage.damage.id, { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

describe('ущерб в период расторжения (§2.3 п.5)', () => {
  it('списание уменьшает счёт возврата депозита', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9630', 2);
      const residencyId = fixture.residents[0]?.residencyId ?? '';

      await terminateResidency(
        fixture.admin,
        residencyId,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const damage = await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Матрас', amount: 10_000, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      // Расторгающийся жилец делит ущерб наравне с остальными.
      expect(damage.shares).toHaveLength(2);

      const invoice = await createRefundInvoice(fixture.admin, residencyId, {
        executor: tx,
        instant: INSTANT,
      });

      expect(invoice?.total).toBe(DEPOSIT - 5_000);
    });
  });
});

describe('жилец видит списание в движении депозита (модуль 7)', () => {
  it('строка называется ущербом и показывает число участников', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9640', 4);

      await createDamage(
        fixture.admin,
        { houseId: fixture.houseA, title: 'Ручка в туалете', amount: 1_800, splitMode: 'all' },
        { executor: tx, today: TODAY },
      );

      const view = await readDepositView(
        fixture.resident,
        fixture.residents[0]?.residencyId ?? '',
        { year: 2026 },
        { executor: tx, today: TODAY },
      );

      const movement = view.transactions.find((entry) => entry.type === 'damage_share');

      expect(movement?.note).toBe('Ручка в туалете');
      expect(view.participantsOf[movement?.id ?? '']).toBe(4);
    });
  });
});
