import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedChartOfAccounts } from '@/db/testing/chart-of-accounts';
import { seedRow } from '@/db/testing/rotation-row';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { approveAbsence, rejectAbsence, submitAbsence } from './absences';
import { readCalendar } from './rotation-calendar';
import { generateSchedule, refreshFutureAssignments } from './rotation-schedule';
import { closeUtilityPeriod, openUtilityPeriod, readUtilityPeriod } from './utilities';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Связи отсутствий (docs/03-BUSINESS-RULES.md §4.2, §9).
 *
 * Одобренный отъезд уменьшает дни коммуналки строго между датами и снимает
 * жильца с ротации общей зоны. Болезнь коммуналку не трогает, но от ротации
 * освобождает. Комнатные и генеральные уборки не освобождаются вовсе.
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

/** Сентябрь 2026: месяц коммуналки и месяц ротаций. */
const MONTH = parseBusinessDate('2026-09-01');
const TODAY = parseBusinessDate('2026-09-07');
const MONDAY = parseBusinessDate('2026-09-14');
const NOW = parseInstant('2026-09-07T12:00:00+05:00');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `eff-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const slug = `eff-a-${suffix}`;
  const [house] = await tx.insert(schema.houses).values({ orgId, name: 'Дом A', slug }).returning();
  const houseId = house?.id ?? '';

  await seedChartOfAccounts(tx, orgId, [{ id: houseId, slug, name: 'Дом A' }]);

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'living', name: 'Комната 1' })
    .returning();
  const [yard] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'common', name: 'Двор' })
    .returning();

  const [yardChecklist] = await tx
    .insert(schema.areaChecklists)
    .values({ areaId: yard?.id ?? '', type: 'regular', title: 'Двор', peopleNeeded: 1 })
    .returning();
  const [roomChecklist] = await tx
    .insert(schema.areaChecklists)
    .values({ areaId: room?.id ?? '', type: 'regular', title: 'Комната', peopleNeeded: 1 })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  async function resident(tag: string, number: number): Promise<{ userId: string; bedId: string }> {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7709${suffix}${tag}`, passwordHash: 'x', role: 'resident' })
      .returning();

    const [residency] = await tx
      .insert(schema.residencies)
      .values({
        orgId,
        userId: user?.id ?? '',
        houseId,
        status: 'active',
        moveInDate: '2026-09-01',
      })
      .returning();

    const [bed] = await tx
      .insert(schema.beds)
      .values({
        houseId,
        areaId: room?.id ?? '',
        label: `М${String(number)}`,
        tier: 'lower',
        number,
      })
      .returning();

    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId: bed?.id ?? '',
      price: 100_000,
      period: '[2026-09-01,)',
    });

    return { userId: user?.id ?? '', bedId: bed?.id ?? '' };
  }

  const first = await resident('1', 1);
  const second = await resident('2', 2);

  const context = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: forHouse });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseId,
    slug,
    room: room?.id ?? '',
    yard: yard?.id ?? '',
    yardChecklist: yardChecklist?.id ?? '',
    roomChecklist: roomChecklist?.id ?? '',
    first,
    second,
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    dweller: actor(context('resident', first.userId, null)),
  };
}

/** Одобренный отъезд с 10 по 14 сентября: дни 11–13 не считаются (§4.2). */
async function approvedTrip(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
  type: 'long' | 'sick' = 'long',
): Promise<string> {
  const absence = await submitAbsence(
    fixture.dweller,
    {
      type,
      startDate: parseBusinessDate('2026-09-10'),
      endDate: parseBusinessDate('2026-09-14'),
      reason: type === 'long' ? 'Уезжаю' : 'Болею',
    },
    { executor: tx, today: TODAY, instant: NOW },
  );

  await approveAbsence(fixture.admin, absence.id, { executor: tx, today: TODAY, instant: NOW });

  return absence.id;
}

describe('коммуналка и отсутствия (§4.2)', () => {
  it('одобренный отъезд снимает дни строго между датами', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5401');
      await approvedTrip(tx, fixture);

      const period = await openUtilityPeriod(fixture.admin, fixture.houseId, MONTH, {
        executor: tx,
      });
      await tx.insert(schema.utilityLines).values({
        periodId: period.id,
        title: 'Электричество',
        amount: 30_000,
      });

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      const mine = view.preview.allocations.find((row) => row.userId === fixture.first.userId);
      const neighbour = view.preview.allocations.find(
        (row) => row.userId === fixture.second.userId,
      );

      // Сосед прожил все 30 дней, уехавший — 27: 11, 12 и 13 сентября не в счёт.
      expect(view.preview.allocations).toHaveLength(2);
      expect(mine?.days).toBe(27);
      expect(neighbour?.days).toBe(30);
    });
  });

  it('болезнь коммуналку не уменьшает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5402');
      await approvedTrip(tx, fixture, 'sick');

      const period = await openUtilityPeriod(fixture.admin, fixture.houseId, MONTH, {
        executor: tx,
      });
      await tx.insert(schema.utilityLines).values({
        periodId: period.id,
        title: 'Электричество',
        amount: 30_000,
      });

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      const mine = view.preview.allocations.find((row) => row.userId === fixture.first.userId);

      expect(mine?.days).toBe(30);
    });
  });

  it('неодобренный отъезд дней не снимает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5403');

      await submitAbsence(
        fixture.dweller,
        {
          type: 'long',
          startDate: parseBusinessDate('2026-09-10'),
          endDate: parseBusinessDate('2026-09-14'),
          reason: 'Уезжаю',
        },
        { executor: tx, today: TODAY, instant: NOW },
      );

      const period = await openUtilityPeriod(fixture.admin, fixture.houseId, MONTH, {
        executor: tx,
      });
      await tx.insert(schema.utilityLines).values({
        periodId: period.id,
        title: 'Электричество',
        amount: 30_000,
      });

      const view = await readUtilityPeriod(fixture.admin, period.id, { executor: tx });
      const mine = view.preview.allocations.find((row) => row.userId === fixture.first.userId);

      expect(mine?.days).toBe(30);
    });
  });

  it('снимок закрытого периода считает те же дни', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5404');
      await approvedTrip(tx, fixture);

      const period = await openUtilityPeriod(fixture.admin, fixture.houseId, MONTH, {
        executor: tx,
      });
      await tx.insert(schema.utilityLines).values({
        periodId: period.id,
        title: 'Электричество',
        amount: 30_000,
      });

      const closed = await closeUtilityPeriod(fixture.admin, period.id, {
        executor: tx,
        today: parseBusinessDate('2026-10-01'),
        instant: parseInstant('2026-10-01T10:00:00+05:00'),
      });

      const mine = closed.allocations.find((row) => row.userId === fixture.first.userId);

      expect(mine?.days).toBe(27);
    });
  });
});

describe('ротации и отсутствия (§6.3, §9)', () => {
  /** Ряд общих зон: двор по понедельникам, два места. */
  async function commonRow(
    tx: Transaction,
    fixture: Awaited<ReturnType<typeof seed>>,
  ): Promise<void> {
    await seedRow(
      fixture.admin,
      {
        houseId: fixture.houseId,
        name: 'Общие зоны',
        type: 'common',
        weekday: 1,
        startDate: MONDAY,
        bedIds: [fixture.first.bedId, fixture.second.bedId],
        zones: [{ areaId: fixture.yard, checklistId: fixture.yardChecklist }],
      },
      { executor: tx },
    );

    await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
      executor: tx,
      today: TODAY,
    });
  }

  it('отсутствующий в день уборки общей зоны снимается с неё', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5410');
      await approvedTrip(tx, fixture);
      await commonRow(tx, fixture);

      const day = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );
      const assignment = day.occurrences[0]?.assignments[0];

      // 14 сентября — день возвращения, но уборку в этот день он не делает:
      // §9 освобождает от ротаций общих зон на всё время отсутствия.
      expect(assignment?.userId).toBeNull();
      expect(assignment?.state).toBe('needs_reassignment');
    });
  });

  it('болезнь тоже освобождает от общей зоны', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5411');
      await approvedTrip(tx, fixture, 'sick');
      await commonRow(tx, fixture);

      const day = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(day.occurrences[0]?.assignments[0]?.state).toBe('needs_reassignment');
    });
  });

  it('комнатная уборка не освобождается автоматически (§9)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5412');
      await approvedTrip(tx, fixture);

      await seedRow(
        fixture.admin,
        {
          houseId: fixture.houseId,
          name: 'Комната 1',
          type: 'room',
          weekday: 0,
          startDate: parseBusinessDate('2026-09-13'),
          bedIds: [fixture.first.bedId, fixture.second.bedId],
          zones: [{ areaId: fixture.room, checklistId: fixture.roomChecklist }],
        },
        { executor: tx },
      );
      await generateSchedule(fixture.admin, fixture.houseId, parseBusinessDate('2026-09-13'), {
        executor: tx,
        today: TODAY,
      });

      const day = await readCalendar(
        fixture.admin,
        { from: parseBusinessDate('2026-09-13'), to: parseBusinessDate('2026-09-13') },
        { executor: tx, houseId: fixture.houseId },
      );
      const assignment = day.occurrences[0]?.assignments[0];

      expect(assignment?.userId).toBe(fixture.first.userId);
      expect(assignment?.state).toBe('assigned');
    });
  });

  it('одобрение отсутствия задним числом пересчитывает будущие ротации', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5413');
      await commonRow(tx, fixture);

      const before = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );
      expect(before.occurrences[0]?.assignments[0]?.userId).toBe(fixture.first.userId);

      await approvedTrip(tx, fixture);
      await refreshFutureAssignments(fixture.admin, fixture.houseId, TODAY, { executor: tx });

      const after = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(after.occurrences[0]?.assignments[0]?.state).toBe('needs_reassignment');
    });
  });

  it('одобрение снимает с будущей ротации без ручного пересчёта', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5414');
      await commonRow(tx, fixture);

      await approvedTrip(tx, fixture);

      const after = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(after.occurrences[0]?.assignments[0]?.userId).toBeNull();
      expect(after.occurrences[0]?.assignments[0]?.state).toBe('needs_reassignment');
    });
  });

  it('отклонение ранее одобренного возвращает в ротацию', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5415');
      await commonRow(tx, fixture);

      const absenceId = await approvedTrip(tx, fixture);
      await rejectAbsence(fixture.admin, absenceId, 'Справки нет', {
        executor: tx,
        today: TODAY,
        instant: NOW,
      });

      const after = await readCalendar(
        fixture.admin,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(after.occurrences[0]?.assignments[0]?.userId).toBe(fixture.first.userId);
      expect(after.occurrences[0]?.assignments[0]?.state).toBe('assigned');
    });
  });
});
