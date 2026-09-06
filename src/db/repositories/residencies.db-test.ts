import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { NotFoundError } from '@/lib/errors';
import { businessDate } from '@/lib/time';

import { periodLiteral } from '../period';
import {
  assignBed,
  createResidency,
  findOpenAssignment,
  listAssignments,
  listResidencies,
  releaseBed,
  requireResidency,
} from './residencies';

import type { AccessContext } from '../access';
import type { Database, Transaction } from '../client';

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

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }

  return parts.join(' | ');
}

async function failureText(
  tx: Transaction,
  body: (inner: Transaction) => Promise<unknown>,
): Promise<string> {
  try {
    await tx.transaction(async (inner) => {
      await body(inner);
    });
    return '';
  } catch (error) {
    return errorChain(error);
  }
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `res-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `res-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `res-b-${suffix}` })
    .returning();

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId: houseA?.id ?? '', type: 'living', name: 'Комната 1' })
    .returning();

  const [bed] = await tx
    .insert(schema.beds)
    .values({
      houseId: houseA?.id ?? '',
      areaId: room?.id ?? '',
      label: 'верх',
      tier: 'upper',
      number: 1,
      defaultPrice: 65_000,
    })
    .returning();
  const [otherBed] = await tx
    .insert(schema.beds)
    .values({
      houseId: houseA?.id ?? '',
      areaId: room?.id ?? '',
      label: 'низ',
      tier: 'lower',
      number: 1,
      defaultPrice: 70_000,
    })
    .returning();

  const [first] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77061${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const [second] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77062${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const superadmin: AccessContext = {
    orgId,
    userId: '00000000-0000-0000-0000-000000000000',
    role: 'superadmin',
    houseId: null,
  };
  const adminA: AccessContext = {
    orgId,
    userId: '00000000-0000-0000-0000-000000000001',
    role: 'admin',
    houseId: houseA?.id ?? null,
  };

  return {
    orgId,
    houseA: houseA?.id ?? '',
    houseB: houseB?.id ?? '',
    bed: bed?.id ?? '',
    otherBed: otherBed?.id ?? '',
    firstUser: first?.id ?? '',
    secondUser: second?.id ?? '',
    superadmin,
    adminA,
  };
}

/**
 * Инвариант 1 из docs/02-DATA-MODEL.md: одно место не занято двумя
 * проживаниями в пересекающиеся периоды. Держится на ограничении
 * исключения, а значит — на расширении btree_gist.
 */
describe('занятость места', () => {
  it('двое не занимают одно место в пересекающиеся периоды', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100001');

      const first = await createResidency(
        fixture.superadmin,
        { userId: fixture.firstUser, houseId: fixture.houseA },
        tx,
      );
      const second = await createResidency(
        fixture.superadmin,
        { userId: fixture.secondUser, houseId: fixture.houseA },
        tx,
      );

      await assignBed(
        {
          residencyId: first.id,
          bedId: fixture.bed,
          price: 65_000,
          from: businessDate(2026, 9, 1),
        },
        tx,
      );

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.bedAssignments).values({
          residencyId: second.id,
          bedId: fixture.bed,
          price: 65_000,
          period: periodLiteral({ from: businessDate(2026, 10, 1), to: null }),
        }),
      );

      expect(failure).toMatch(/bed_assignments_bed_period_excl/);
    });
  });

  it('смежные периоды не считаются пересечением: место освободилось — можно заезжать', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100002');

      const first = await createResidency(
        fixture.superadmin,
        { userId: fixture.firstUser, houseId: fixture.houseA },
        tx,
      );
      const second = await createResidency(
        fixture.superadmin,
        { userId: fixture.secondUser, houseId: fixture.houseA },
        tx,
      );

      await tx.insert(schema.bedAssignments).values({
        residencyId: first.id,
        bedId: fixture.bed,
        price: 65_000,
        period: periodLiteral({ from: businessDate(2026, 9, 1), to: businessDate(2026, 12, 1) }),
      });

      // День выезда в период не входит, поэтому 1 декабря место свободно.
      await expect(
        tx.insert(schema.bedAssignments).values({
          residencyId: second.id,
          bedId: fixture.bed,
          price: 65_000,
          period: periodLiteral({ from: businessDate(2026, 12, 1), to: null }),
        }),
      ).resolves.toBeDefined();
    });
  });

  it('открытый период занимает место и на будущее', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '100003');

      const first = await createResidency(
        fixture.superadmin,
        { userId: fixture.firstUser, houseId: fixture.houseA },
        tx,
      );
      const second = await createResidency(
        fixture.superadmin,
        { userId: fixture.secondUser, houseId: fixture.houseA },
        tx,
      );

      await assignBed(
        {
          residencyId: first.id,
          bedId: fixture.bed,
          price: 65_000,
          from: businessDate(2026, 9, 1),
        },
        tx,
      );

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.bedAssignments).values({
          residencyId: second.id,
          bedId: fixture.bed,
          price: 65_000,
          period: periodLiteral({ from: businessDate(2030, 1, 1), to: null }),
        }),
      );

      expect(failure).toMatch(/bed_assignments_bed_period_excl/);
    });
  });
});

/**
 * Инвариант 2: у активного проживания ровно одно действующее назначение.
 * Смена места закрывает прежний период, а не добавляет второй.
 */
describe('одно проживание — одно место', () => {
  it('два места одновременно занять нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200001');
      const residency = await createResidency(
        fixture.superadmin,
        { userId: fixture.firstUser, houseId: fixture.houseA },
        tx,
      );

      await assignBed(
        {
          residencyId: residency.id,
          bedId: fixture.bed,
          price: 65_000,
          from: businessDate(2026, 9, 1),
        },
        tx,
      );

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.bedAssignments).values({
          residencyId: residency.id,
          bedId: fixture.otherBed,
          price: 70_000,
          period: periodLiteral({ from: businessDate(2026, 10, 1), to: null }),
        }),
      );

      expect(failure).toMatch(/bed_assignments_residency_period_excl/);
    });
  });

  it('смена места закрывает прежний период и открывает новый', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200002');
      const residency = await createResidency(
        fixture.superadmin,
        { userId: fixture.firstUser, houseId: fixture.houseA },
        tx,
      );

      await assignBed(
        {
          residencyId: residency.id,
          bedId: fixture.bed,
          price: 65_000,
          from: businessDate(2026, 9, 1),
        },
        tx,
      );
      await assignBed(
        {
          residencyId: residency.id,
          bedId: fixture.otherBed,
          price: 70_000,
          from: businessDate(2026, 11, 1),
        },
        tx,
      );

      const history = await listAssignments(residency.id, tx);
      const open = await findOpenAssignment(residency.id, tx);

      // История сохранена целиком, действующее назначение одно.
      expect(history).toHaveLength(2);
      expect(open?.bedId).toBe(fixture.otherBed);
      expect(history.map((item) => item.period)).toContain('[2026-09-01,2026-11-01)');
    });
  });

  it('освобождение места закрывает период, но не стирает историю', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200003');
      const residency = await createResidency(
        fixture.superadmin,
        { userId: fixture.firstUser, houseId: fixture.houseA },
        tx,
      );

      await assignBed(
        {
          residencyId: residency.id,
          bedId: fixture.bed,
          price: 65_000,
          from: businessDate(2026, 9, 1),
        },
        tx,
      );
      await releaseBed(residency.id, businessDate(2026, 12, 10), tx);

      expect(await findOpenAssignment(residency.id, tx)).toBeNull();
      expect(await listAssignments(residency.id, tx)).toHaveLength(1);
    });
  });

  it('освобождённое место занимает следующий жилец', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '200004');
      const first = await createResidency(
        fixture.superadmin,
        { userId: fixture.firstUser, houseId: fixture.houseA },
        tx,
      );
      const second = await createResidency(
        fixture.superadmin,
        { userId: fixture.secondUser, houseId: fixture.houseA },
        tx,
      );

      await assignBed(
        {
          residencyId: first.id,
          bedId: fixture.bed,
          price: 65_000,
          from: businessDate(2026, 9, 1),
        },
        tx,
      );
      await releaseBed(first.id, businessDate(2026, 12, 10), tx);

      await expect(
        assignBed(
          {
            residencyId: second.id,
            bedId: fixture.bed,
            price: 65_000,
            from: businessDate(2026, 12, 10),
          },
          tx,
        ),
      ).resolves.toBeDefined();
    });
  });
});

describe('видимость проживаний', () => {
  it('админ видит проживания своего дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300001');
      await createResidency(
        fixture.superadmin,
        { userId: fixture.firstUser, houseId: fixture.houseA },
        tx,
      );

      const visible = await listResidencies(fixture.adminA, {}, tx);

      expect(visible).toHaveLength(1);
    });
  });

  it('проживание чужого дома неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300002');
      const strangerResidency = await createResidency(
        fixture.superadmin,
        { userId: fixture.secondUser, houseId: fixture.houseB },
        tx,
      );

      await expect(
        requireResidency(fixture.adminA, strangerResidency.id, tx),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        listResidencies(fixture.adminA, { houseId: fixture.houseB }, tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('жилец видит только своё проживание', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '300003');
      const own = await createResidency(
        fixture.superadmin,
        { userId: fixture.firstUser, houseId: fixture.houseA },
        tx,
      );
      await createResidency(
        fixture.superadmin,
        { userId: fixture.secondUser, houseId: fixture.houseA },
        tx,
      );

      const resident: AccessContext = {
        orgId: fixture.orgId,
        userId: fixture.firstUser,
        role: 'resident',
        houseId: null,
      };

      const visible = await listResidencies(resident, {}, tx);

      expect(visible.map((item) => item.id)).toEqual([own.id]);
    });
  });
});
