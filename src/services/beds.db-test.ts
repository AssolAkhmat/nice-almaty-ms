import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { assignBedToResidency, houseLayout, myPlacement, releaseBedOfResidency } from './beds';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Назначение места и цены (§1.2 п.4).
 *
 * Проверяется то, что живёт в базе: история назначений при смене места,
 * занятость в схеме дома и изоляция домов. Само ограничение «одно место —
 * одно проживание» проверено в `src/db/repositories/residencies.db-test.ts`.
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

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `bed-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `bed-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `bed-b-${suffix}` })
    .returning();

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId: houseA?.id ?? '', name: 'Комната 1', type: 'living' })
    .returning();

  const [lower] = await tx
    .insert(schema.beds)
    .values({
      houseId: houseA?.id ?? '',
      areaId: room?.id ?? '',
      number: 1,
      tier: 'lower',
      label: 'Место 1, низ',
      defaultPrice: 120_000,
    })
    .returning();

  const [upper] = await tx
    .insert(schema.beds)
    .values({
      houseId: houseA?.id ?? '',
      areaId: room?.id ?? '',
      number: 1,
      tier: 'upper',
      label: 'Место 1, верх',
      defaultPrice: 110_000,
    })
    .returning();

  // Общая зона: мест в ней не бывает, и на схеме дома ей не место (T9.9).
  await tx
    .insert(schema.areas)
    .values({ houseId: houseA?.id ?? '', name: 'Кухня', type: 'common' });

  const [foreignRoom] = await tx
    .insert(schema.areas)
    .values({ houseId: houseB?.id ?? '', name: 'Комната 1', type: 'living' })
    .returning();

  const [foreignBed] = await tx
    .insert(schema.beds)
    .values({
      houseId: houseB?.id ?? '',
      areaId: foreignRoom?.id ?? '',
      number: 1,
      tier: 'lower',
      label: 'Чужое место',
      defaultPrice: 100_000,
    })
    .returning();

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7702${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [admin] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7701${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseA?.id ?? '',
    })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({ orgId, userId: user?.id ?? '', houseId: houseA?.id ?? '' })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseA: houseA?.id ?? '',
    houseB: houseB?.id ?? '',
    roomId: room?.id ?? '',
    lowerBed: lower?.id ?? '',
    upperBed: upper?.id ?? '',
    foreignBed: foreignBed?.id ?? '',
    residencyId: residency?.id ?? '',
    userId: user?.id ?? '',
    resident: actor(context('resident', user?.id ?? '', null)),
    admin: actor(context('admin', admin?.id ?? '', houseA?.id ?? null)),
  };
}

describe('назначение места', () => {
  it('берёт цену места по умолчанию', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8001');

      const assignment = await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.lowerBed },
        { executor: tx, today: TODAY },
      );

      expect(assignment.price).toBe(120_000);
    });
  });

  it('индивидуальная цена перекрывает цену места', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8002');

      const assignment = await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.lowerBed, price: 90_000 },
        { executor: tx, today: TODAY },
      );

      expect(assignment.price).toBe(90_000);
    });
  });

  it('дробная цена не принимается: деньги — целые тенге', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8003');

      await expect(
        assignBedToResidency(
          fixture.admin,
          { residencyId: fixture.residencyId, bedId: fixture.lowerBed, price: 90_000.5 },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('место чужого дома не назначается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8004');

      await expect(
        assignBedToResidency(
          fixture.admin,
          { residencyId: fixture.residencyId, bedId: fixture.foreignBed },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  it('жилец место себе не назначает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8005');

      await expect(
        assignBedToResidency(
          fixture.resident,
          { residencyId: fixture.residencyId, bedId: fixture.lowerBed },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  it('назначение попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8006');

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.lowerBed },
        { executor: tx, today: TODAY },
      );

      const actions = (await tx.select().from(schema.auditLog)).map((entry) => entry.action);
      expect(actions).toContain('bed.assigned');
    });
  });
});

describe('смена места', () => {
  it('закрывает прежнее назначение той же датой и открывает новое', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8010');

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.lowerBed },
        { executor: tx, today: TODAY },
      );

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.upperBed },
        { executor: tx, today: parseBusinessDate('2026-10-01') },
      );

      const assignments = await tx
        .select()
        .from(schema.bedAssignments)
        .where(eq(schema.bedAssignments.residencyId, fixture.residencyId));

      expect(assignments).toHaveLength(2);

      const closed = assignments.find((row) => row.bedId === fixture.lowerBed);
      const open = assignments.find((row) => row.bedId === fixture.upperBed);

      // Полуоткрытый период: день переезда — уже день нового места.
      expect(closed?.period).toBe('[2026-09-15,2026-10-01)');
      expect(open?.period).toBe('[2026-10-01,)');
    });
  });

  it('история прежней цены сохраняется, а не переписывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8011');

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.lowerBed, price: 120_000 },
        { executor: tx, today: TODAY },
      );
      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.upperBed, price: 95_000 },
        { executor: tx, today: parseBusinessDate('2026-10-01') },
      );

      const prices = (
        await tx
          .select()
          .from(schema.bedAssignments)
          .where(eq(schema.bedAssignments.residencyId, fixture.residencyId))
      )
        .map((row) => row.price)
        .sort((first, second) => first - second);

      expect(prices).toEqual([95_000, 120_000]);
    });
  });

  it('освобождение закрывает период, но запись остаётся', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8012');

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.lowerBed },
        { executor: tx, today: TODAY },
      );

      await releaseBedOfResidency(
        fixture.admin,
        fixture.residencyId,
        parseBusinessDate('2026-12-01'),
        { executor: tx, today: TODAY },
      );

      const [assignment] = await tx
        .select()
        .from(schema.bedAssignments)
        .where(eq(schema.bedAssignments.residencyId, fixture.residencyId));

      expect(assignment?.period).toBe('[2026-09-15,2026-12-01)');

      const actions = (await tx.select().from(schema.auditLog)).map((entry) => entry.action);
      expect(actions).toContain('bed.released');
    });
  });
});

describe('схема дома', () => {
  it('показывает комнаты, места и занятость', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8020');

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.lowerBed },
        { executor: tx, today: TODAY },
      );

      const layout = await houseLayout(fixture.admin, fixture.houseA, { executor: tx });

      // Одна комната: кухня из фикстуры на схему не попадает — мест в ней не бывает.
      expect(layout).toHaveLength(1);
      expect(layout[0]?.area.name).toBe('Комната 1');
      expect(layout[0]?.beds).toHaveLength(2);

      const occupied = layout[0]?.beds.find((bed) => bed.bedId === fixture.lowerBed);
      const free = layout[0]?.beds.find((bed) => bed.bedId === fixture.upperBed);

      expect(occupied?.occupiedBy?.residencyId).toBe(fixture.residencyId);
      expect(free?.occupiedBy).toBeNull();
    });
  });

  it('чужой дом админу не показывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8021');

      await expect(houseLayout(fixture.admin, fixture.houseB, { executor: tx })).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  it('жилец видит только своё место, а не схему дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8022');

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: fixture.lowerBed },
        { executor: tx, today: TODAY },
      );

      const placement = await myPlacement(fixture.resident, fixture.residencyId, { executor: tx });
      expect(placement?.bed.id).toBe(fixture.lowerBed);

      await expect(houseLayout(fixture.resident, fixture.houseA, { executor: tx })).rejects.toThrow(
        NotFoundError,
      );
    });
  });
});
