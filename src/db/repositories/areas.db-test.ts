import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { eq } from 'drizzle-orm';

import * as schema from '@/db/schema';
import { parseInstant } from '@/lib/time';
import { NotFoundError } from '@/lib/errors';

import { createArea, createBed, listAreas, listBeds, requireBed, updateBed } from './areas';

import type { AccessContext } from '../access';
import type { Database, Transaction } from '../client';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://nice:nice@localhost:5432/nice_almaty';
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
    .values({ name: 'Nice Almaty', slug: `area-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `area-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `area-b-${suffix}` })
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

  return { orgId, houseA: houseA?.id ?? '', houseB: houseB?.id ?? '', superadmin, adminA };
}

describe('зоны', () => {
  it('жилые и общие зоны заводятся и перечисляются по порядку', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1001');

      await createArea(
        fixture.superadmin,
        { houseId: fixture.houseA, type: 'common', name: 'Двор', sortOrder: 2 },
        tx,
      );
      await createArea(
        fixture.superadmin,
        { houseId: fixture.houseA, type: 'living', name: 'Комната 1', sortOrder: 1 },
        tx,
      );

      const list = await listAreas(fixture.superadmin, fixture.houseA, {}, tx);

      expect(list.map((area) => area.name)).toEqual(['Комната 1', 'Двор']);
    });
  });

  it('зоны чужого дома неотличимы от несуществующих', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1002');

      await createArea(
        fixture.superadmin,
        { houseId: fixture.houseB, type: 'living', name: 'Комната соседа' },
        tx,
      );

      await expect(listAreas(fixture.adminA, fixture.houseB, {}, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('архивированные зоны в список не попадают', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1003');
      const area = await createArea(
        fixture.superadmin,
        { houseId: fixture.houseA, type: 'living', name: 'Комната 1' },
        tx,
      );

      // Архивируем точечно: в базе есть строки сида и соседних тестов.
      await tx
        .update(schema.areas)
        .set({ archivedAt: parseInstant('2026-01-01T00:00:00Z') })
        .where(eq(schema.areas.id, area.id));

      const visible = await listAreas(fixture.superadmin, fixture.houseA, {}, tx);
      const all = await listAreas(
        fixture.superadmin,
        fixture.houseA,
        { includeArchived: true },
        tx,
      );

      expect(visible).toHaveLength(0);
      expect(all.map((item) => item.id)).toContain(area.id);
    });
  });
});

describe('спальные места', () => {
  it('заводятся в жилой комнате', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2001');
      const room = await createArea(
        fixture.superadmin,
        { houseId: fixture.houseA, type: 'living', name: 'Комната 3' },
        tx,
      );

      const upper = await createBed(
        fixture.superadmin,
        {
          houseId: fixture.houseA,
          areaId: room.id,
          label: 'Комната 3, верх',
          tier: 'upper',
          number: 1,
          defaultPrice: 65_000,
        },
        tx,
      );

      expect(upper.defaultPrice).toBe(65_000);

      const list = await listBeds(fixture.superadmin, fixture.houseA, {}, tx);
      expect(list).toHaveLength(1);
    });
  });

  it('в общей зоне место завести нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2002');
      const yard = await createArea(
        fixture.superadmin,
        { houseId: fixture.houseA, type: 'common', name: 'Двор' },
        tx,
      );

      await expect(
        createBed(
          fixture.superadmin,
          { houseId: fixture.houseA, areaId: yard.id, label: 'во дворе', tier: 'lower', number: 1 },
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('ярус и номер в комнате не повторяются', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2003');
      const room = await createArea(
        fixture.superadmin,
        { houseId: fixture.houseA, type: 'living', name: 'Комната 1' },
        tx,
      );

      await createBed(
        fixture.superadmin,
        { houseId: fixture.houseA, areaId: room.id, label: 'верх', tier: 'upper', number: 1 },
        tx,
      );

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.beds).values({
          houseId: fixture.houseA,
          areaId: room.id,
          label: 'ещё верх',
          tier: 'upper',
          number: 1,
        }),
      );

      expect(failure).toMatch(/beds_area_number_tier_unique/);

      // Тот же номер на другом ярусе — обычное дело: двухъярусная кровать.
      await expect(
        createBed(
          fixture.superadmin,
          { houseId: fixture.houseA, areaId: room.id, label: 'низ', tier: 'lower', number: 1 },
          tx,
        ),
      ).resolves.toBeDefined();
    });
  });

  it('место чужого дома неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2004');
      const room = await createArea(
        fixture.superadmin,
        { houseId: fixture.houseB, type: 'living', name: 'Комната соседа' },
        tx,
      );
      const bed = await createBed(
        fixture.superadmin,
        { houseId: fixture.houseB, areaId: room.id, label: 'место', tier: 'lower', number: 1 },
        tx,
      );

      await expect(requireBed(fixture.adminA, bed.id, tx)).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateBed(fixture.adminA, bed.id, { defaultPrice: 1 }, tx)).resolves.toBeNull();
    });
  });

  it('зона другого дома не принимает место', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2005');
      const roomInB = await createArea(
        fixture.superadmin,
        { houseId: fixture.houseB, type: 'living', name: 'Комната B' },
        tx,
      );

      await expect(
        createBed(
          fixture.superadmin,
          { houseId: fixture.houseA, areaId: roomInB.id, label: 'x', tier: 'lower', number: 1 },
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
