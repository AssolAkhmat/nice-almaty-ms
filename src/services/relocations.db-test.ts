import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { countFullMonths } from '@/domain/deposit';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { assignBedToResidency } from './beds';
import { groupsNamingUser, relocateResidency } from './relocations';
import {
  closeUtilityPeriod,
  addPeriodLine,
  openUtilityPeriod,
  readUtilityPeriod,
} from './utilities';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Переселение жильца в другой дом (решение D26).
 *
 * Главное, что здесь проверяется, — что ничего не потерялось: депозит,
 * стаж, номер договора, история мест и коммуналка прошлых месяцев.
 * Это не «тест на то, что кнопка работает», а перечень того, что
 * переселение могло бы незаметно стереть.
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

const MOVE_IN = parseBusinessDate('2026-07-01');
const SEPTEMBER = parseBusinessDate('2026-09-01');
const MOVED_ON = parseBusinessDate('2026-09-10');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rel-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const houses: { id: string; slug: string; name: string }[] = [];

  for (const tag of ['a', 'b'] as const) {
    const slug = `rel-${tag}-${suffix}`;
    const [house] = await tx
      .insert(schema.houses)
      .values({ orgId, name: `Дом ${tag.toUpperCase()}`, slug })
      .returning();
    houses.push({ id: house?.id ?? '', slug, name: house?.name ?? '' });
  }

  await seedChartOfAccounts(tx, orgId, houses);

  const beds: string[] = [];

  for (const [index, house] of houses.entries()) {
    const [area] = await tx
      .insert(schema.areas)
      .values({ houseId: house.id, type: 'living', name: 'Комната 1' })
      .returning();

    const [bed] = await tx
      .insert(schema.beds)
      .values({
        houseId: house.id,
        areaId: area?.id ?? '',
        label: `М${String(index + 1)}`,
        tier: 'lower',
        number: 1,
        defaultPrice: 90_000 + index * 10_000,
      })
      .returning();

    beds.push(bed?.id ?? '');
  }

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7770${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7771${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [adminA] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7772${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houses[0]?.id ?? '',
    })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: user?.id ?? '',
      houseId: houses[0]?.id ?? '',
      status: 'active',
      moveInDate: MOVE_IN,
      contractNumber: `2026-${suffix}`,
      depositAmount: 90_000,
    })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const superadmin: UserActor = { context: context('superadmin', superUser?.id ?? '', null) };
  const admin: UserActor = {
    context: context('admin', adminA?.id ?? '', houses[0]?.id ?? null),
  };

  await assignBedToResidency(
    superadmin,
    { residencyId: residency?.id ?? '', bedId: beds[0] ?? '', price: 90_000, from: MOVE_IN },
    { executor: tx, today: MOVE_IN },
  );

  return {
    orgId,
    houseA: houses[0]?.id ?? '',
    houseB: houses[1]?.id ?? '',
    bedA: beds[0] ?? '',
    bedB: beds[1] ?? '',
    userId: user?.id ?? '',
    residencyId: residency?.id ?? '',
    superadmin,
    admin,
  };
}

async function relocate(tx: Transaction, fixture: Awaited<ReturnType<typeof seed>>, extra = {}) {
  return relocateResidency(
    fixture.superadmin,
    {
      residencyId: fixture.residencyId,
      houseId: fixture.houseB,
      bedId: fixture.bedB,
      price: 100_000,
      from: MOVED_ON,
      ...extra,
    },
    { executor: tx, today: MOVED_ON },
  );
}

describe('переселение в другой дом', () => {
  it('меняет дом, место и цену, оставляя то же проживание', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7001');

      const result = await relocate(tx, fixture);

      expect(result.residency.id).toBe(fixture.residencyId);
      expect(result.residency.houseId).toBe(fixture.houseB);
      expect(result.assignment.houseId).toBe(fixture.houseB);
      expect(result.assignment.price).toBe(100_000);
      expect(result.fromHouseId).toBe(fixture.houseA);
    });
  });

  /*
   * Ради этого всё и затевалось: расторжение с новым заселением обнулило бы
   * стаж, и депозит при выезде сгорел бы как у прожившего меньше трёх месяцев.
   */
  it('стаж, депозит и номер договора переезд не замечают', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7002');

      const [before] = await tx
        .select()
        .from(schema.residencies)
        .where(eq(schema.residencies.id, fixture.residencyId));

      await relocate(tx, fixture);

      const [after] = await tx
        .select()
        .from(schema.residencies)
        .where(eq(schema.residencies.id, fixture.residencyId));

      expect(after?.moveInDate).toBe(before?.moveInDate);
      expect(after?.contractNumber).toBe(before?.contractNumber);
      expect(after?.depositAmount).toBe(before?.depositAmount);

      // Стаж считается от той же даты заезда: июль, август, сентябрь.
      expect(
        countFullMonths(
          parseBusinessDate(after?.moveInDate ?? ''),
          parseBusinessDate('2026-10-01'),
        ),
      ).toBe(3);
    });
  });

  it('история мест не переписывается: сентябрь остаётся за старым домом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7003');

      await relocate(tx, fixture);

      const history = await tx
        .select()
        .from(schema.bedAssignments)
        .where(eq(schema.bedAssignments.residencyId, fixture.residencyId));

      expect(history).toHaveLength(2);

      const old = history.find((row) => row.houseId === fixture.houseA);
      const fresh = history.find((row) => row.houseId === fixture.houseB);

      expect(old?.period).toBe('[2026-07-01,2026-09-10)');
      expect(fresh?.period).toBe('[2026-09-10,)');
    });
  });

  it('пишет в журнал оба дома, место и цену', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7004');

      await relocate(tx, fixture);

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.orgId, fixture.orgId));

      const moved = entries.find((entry) => entry.action === 'residency.relocated');

      expect(moved).toBeDefined();
      expect((moved?.before as { houseId?: string } | null)?.houseId).toBe(fixture.houseA);
      expect((moved?.after as { houseId?: string } | null)?.houseId).toBe(fixture.houseB);
    });
  });

  /*
   * Отказ приходит как «не найдено», а не «запрещено»: чужой дом неотличим
   * от несуществующего (P1-1). Перебором идентификаторов состав сети узнать
   * нельзя, и переселение этого правила не нарушает.
   */
  it('админ одного дома переселить не может: это действие сети', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7005');

      await expect(
        relocateResidency(
          fixture.admin,
          {
            residencyId: fixture.residencyId,
            houseId: fixture.houseB,
            bedId: fixture.bedB,
            from: MOVED_ON,
          },
          { executor: tx, today: MOVED_ON },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('переселение в тот же дом — не переселение', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7006');

      await expect(
        relocateResidency(
          fixture.superadmin,
          { residencyId: fixture.residencyId, houseId: fixture.houseA, bedId: fixture.bedA },
          { executor: tx, today: MOVED_ON },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('место чужого дома не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7007');

      await expect(
        relocateResidency(
          fixture.superadmin,
          { residencyId: fixture.residencyId, houseId: fixture.houseB, bedId: fixture.bedA },
          { executor: tx, today: MOVED_ON },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('переселить раньше заезда нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7008');

      await expect(
        relocate(tx, fixture, { from: parseBusinessDate('2026-06-01') }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe('коммуналка после переселения', () => {
  /*
   * Самое дорогое место всей задачи. Прежний расчёт дал бы обоим домам
   * по полному месяцу дней: человек заплатил бы за сентябрь дважды.
   */
  it('месяц переселения делится между домами по дням', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7010');

      await relocate(tx, fixture);

      const periodA = await openUtilityPeriod(fixture.superadmin, fixture.houseA, SEPTEMBER, {
        executor: tx,
      });
      const periodB = await openUtilityPeriod(fixture.superadmin, fixture.houseB, SEPTEMBER, {
        executor: tx,
      });

      const viewA = await readUtilityPeriod(fixture.superadmin, periodA.id, { executor: tx });
      const viewB = await readUtilityPeriod(fixture.superadmin, periodB.id, { executor: tx });

      const daysA = viewA.preview.allocations.find((row) => row.userId === fixture.userId)?.days;
      const daysB = viewB.preview.allocations.find((row) => row.userId === fixture.userId)?.days;

      expect(daysA).toBe(9);
      expect(daysB).toBe(21);
      expect((daysA ?? 0) + (daysB ?? 0)).toBe(30);
    });
  });

  it('прошлый месяц остаётся за старым домом, а в новом его нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7011');

      await relocate(tx, fixture);

      const august = parseBusinessDate('2026-08-01');

      const periodA = await openUtilityPeriod(fixture.superadmin, fixture.houseA, august, {
        executor: tx,
      });
      const periodB = await openUtilityPeriod(fixture.superadmin, fixture.houseB, august, {
        executor: tx,
      });

      const viewA = await readUtilityPeriod(fixture.superadmin, periodA.id, { executor: tx });
      const viewB = await readUtilityPeriod(fixture.superadmin, periodB.id, { executor: tx });

      expect(viewA.preview.allocations.find((row) => row.userId === fixture.userId)?.days).toBe(31);
      expect(viewB.preview.allocations).toHaveLength(0);
    });
  });

  it('доля старого дома доходит до счёта и после переезда', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7012');

      await relocate(tx, fixture);

      const periodA = await openUtilityPeriod(fixture.superadmin, fixture.houseA, SEPTEMBER, {
        executor: tx,
      });

      await addPeriodLine(
        fixture.superadmin,
        periodA.id,
        { title: 'Свет', amount: 9_000 },
        { executor: tx },
      );

      const closed = await closeUtilityPeriod(fixture.superadmin, periodA.id, {
        executor: tx,
        today: parseBusinessDate('2026-10-02'),
      });

      expect(closed.allocations).toHaveLength(1);
      expect(closed.allocations[0]?.userId).toBe(fixture.userId);
      expect(closed.allocations[0]?.days).toBe(9);
    });
  });
});

describe('группы допуска покидаемого дома', () => {
  async function withGroup(tx: Transaction, fixture: Awaited<ReturnType<typeof seed>>) {
    const [group] = await tx
      .insert(schema.eligibilityGroups)
      .values({
        orgId: fixture.orgId,
        houseId: fixture.houseA,
        name: 'Не пускать в кухню',
        rule: { base: 'all', excludeUserIds: [fixture.userId] },
      })
      .returning();

    return group?.id ?? '';
  }

  it('показывает, в каких поимённых группах человек назван', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7020');
      const groupId = await withGroup(tx, fixture);

      const groups = await groupsNamingUser(fixture.superadmin, fixture.houseA, fixture.userId, {
        executor: tx,
      });

      expect(groups.map((group) => group.id)).toEqual([groupId]);
    });
  });

  /*
   * По умолчанию не убирать: человек может вернуться, и снятое исключение
   * стало бы тихим допуском туда, куда его не пускали (указание владельца).
   */
  it('по умолчанию из групп не убирает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7021');
      const groupId = await withGroup(tx, fixture);

      const result = await relocate(tx, fixture);

      expect(result.leftGroups).toEqual([]);

      const [group] = await tx
        .select()
        .from(schema.eligibilityGroups)
        .where(eq(schema.eligibilityGroups.id, groupId));

      expect((group?.rule as { excludeUserIds?: string[] }).excludeUserIds).toEqual([
        fixture.userId,
      ]);
    });
  });

  it('убирает только те группы, которые назвал админ', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7022');
      const groupId = await withGroup(tx, fixture);

      const result = await relocate(tx, fixture, { leaveGroupIds: [groupId] });

      expect(result.leftGroups).toEqual([groupId]);

      const [group] = await tx
        .select()
        .from(schema.eligibilityGroups)
        .where(eq(schema.eligibilityGroups.id, groupId));

      expect((group?.rule as { excludeUserIds?: string[] }).excludeUserIds).toEqual([]);
    });
  });
});
