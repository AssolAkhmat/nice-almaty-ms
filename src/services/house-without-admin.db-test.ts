import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { seedRow } from '@/db/testing/rotation-row';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { createInvoice } from './invoices';
import { readCalendar } from './rotation-calendar';
import { markAssignment } from './rotation-confirmation';
import { generateSchedule } from './rotation-schedule';
import { addPeriodLine, closeUtilityPeriod, openUtilityPeriod } from './utilities';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Дом без админа — обычное состояние сети, а не сбой (указание владельца).
 *
 * Такой дом ведёт суперадмин: он заводит ряды, генерирует расписание,
 * ставит оценки, считает коммуналку и выставляет счета. Ни одно из этих
 * действий не вправе требовать, чтобы у дома был свой админ.
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

const MONDAY = parseBusinessDate('2026-09-07');
const MOMENT = parseInstant('2026-09-07T14:00:00+05:00');
const MONTH = parseBusinessDate('2026-09-01');

/** Дом, у которого админа нет и не будет: в сети только суперадмин. */
async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `nda-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом без админа', slug: `nda-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'living', name: 'Комната 1' })
    .returning();
  const [yard] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'common', name: 'Двор' })
    .returning();

  const [checklist] = await tx
    .insert(schema.areaChecklists)
    .values({ areaId: yard?.id ?? '', type: 'regular', title: 'Двор', peopleNeeded: 1 })
    .returning();

  const [bed] = await tx
    .insert(schema.beds)
    .values({ houseId, areaId: room?.id ?? '', label: 'М1', tier: 'lower', number: 1 })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
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

  await tx.insert(schema.bedAssignments).values({
    residencyId: residency?.id ?? '',
    bedId: bed?.id ?? '',
    price: 100_000,
    period: '[2026-09-01,)',
  });

  const context: AccessContext = {
    orgId,
    userId: superUser?.id ?? '',
    role: 'superadmin',
    houseId: null,
  };

  return {
    orgId,
    houseId,
    bedId: bed?.id ?? '',
    yardId: yard?.id ?? '',
    checklistId: checklist?.id ?? '',
    residencyId: residency?.id ?? '',
    dwellerId: dwellerUser?.id ?? '',
    network: { context, requestId: `req-${suffix}` } satisfies UserActor,
  };
}

describe('дом без админа', () => {
  it('суперадмин заводит ряд, расписание и ставит оценку', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6501');

      await seedRow(
        fixture.network,
        {
          houseId: fixture.houseId,
          name: 'Двор',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
          bedIds: [fixture.bedId],
          zones: [{ areaId: fixture.yardId, checklistId: fixture.checklistId }],
        },
        { executor: tx },
      );

      await generateSchedule(fixture.network, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const day = await readCalendar(
        fixture.network,
        { from: MONDAY, to: MONDAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(day.houseId).toBe(fixture.houseId);
      expect(day.occurrences).toHaveLength(1);

      const assignmentId = day.occurrences[0]?.assignments[0]?.id ?? '';
      const marked = await markAssignment(
        fixture.network,
        assignmentId,
        { state: 'confirmed', score: 9 },
        { executor: tx, instant: MOMENT },
      );

      expect(marked.score).toBe(9);
    });
  });

  it('суперадмин ведёт коммуналку и выставляет счёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6502');

      const period = await openUtilityPeriod(fixture.network, fixture.houseId, MONTH, {
        executor: tx,
      });
      await addPeriodLine(
        fixture.network,
        period.id,
        { title: 'Свет', amount: 30_000 },
        { executor: tx },
      );

      const closed = await closeUtilityPeriod(fixture.network, period.id, {
        executor: tx,
        today: MONDAY,
      });

      expect(closed.allocations).toHaveLength(1);
      expect(closed.allocations[0]?.userId).toBe(fixture.dwellerId);

      const invoice = await createInvoice(
        fixture.network,
        {
          residencyId: fixture.residencyId,
          type: 'monthly',
          periodMonth: MONTH,
          lines: [{ kind: 'rent', title: 'Проживание', amount: 100_000 }],
        },
        { executor: tx, today: MONDAY },
      );

      expect(invoice.houseId).toBe(fixture.houseId);
      expect(invoice.total).toBe(100_000);
    });
  });
});
