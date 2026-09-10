import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { archiveRow, readRows, saveRow } from './rotation-rows';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Ряды ротаций (docs/03-BUSINESS-RULES.md §6.4, `docs/tasks/PHASE-10.md` §2.2).
 *
 * Ряд — имя, тип, день недели и дата первой ротации; у комнатного ещё
 * и комната. Состав и норма живут своими версиями и проверяются
 * в `rotation-day-setup.db-test` (P10-17).
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

/** Понедельник: обычные ряды в примере 6.1 идут по понедельникам. */
const MONDAY = parseBusinessDate('2026-09-07');
/** Воскресенье: день комнатных рядов (§6.4). */
const SUNDAY = parseBusinessDate('2026-09-06');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rows-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `rows-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `rows-b-${suffix}` })
    .returning();

  const houseAId = houseA?.id ?? '';
  const houseBId = houseB?.id ?? '';

  async function area(houseId: string, name: string, type: 'living' | 'common'): Promise<string> {
    const [row] = await tx.insert(schema.areas).values({ houseId, type, name }).returning();

    return row?.id ?? '';
  }

  const room1 = await area(houseAId, 'Комната 1', 'living');
  const yard = await area(houseAId, 'Двор', 'common');
  const roomB = await area(houseBId, 'Комната соседа', 'living');

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId: houseAId })
    .returning();
  const [residentUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
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
    houseB: houseBId,
    room1,
    yard,
    roomB,
    admin: actor(context('admin', adminUser?.id ?? '', houseAId)),
    resident: actor(context('resident', residentUser?.id ?? '', null)),
  };
}

function commonRow(fixture: Awaited<ReturnType<typeof seed>>, name = 'Общие зоны') {
  return {
    houseId: fixture.houseA,
    name,
    type: 'common' as const,
    weekday: 1,
    startDate: MONDAY,
  };
}

describe('ряд общих зон', () => {
  it('заводится и читается: имя, день недели, дата старта, без комнаты', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9401');

      const row = await saveRow(fixture.admin, commonRow(fixture), { executor: tx });

      expect(row.name).toBe('Общие зоны');
      expect(row.weekday).toBe(1);
      expect(row.startDate).toBe(MONDAY);
      expect(row.roomAreaId).toBeNull();
      expect(row.isActive).toBe(true);

      const rows = await readRows(fixture.admin, fixture.houseA, { executor: tx });
      expect(rows.map((item) => item.id)).toEqual([row.id]);
    });
  });

  it('правка меняет ряд на месте, а не заводит второй', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9402');

      const row = await saveRow(fixture.admin, commonRow(fixture), { executor: tx });
      const edited = await saveRow(
        fixture.admin,
        {
          ...commonRow(fixture, 'Будни'),
          rowId: row.id,
          weekday: 3,
          startDate: parseBusinessDate('2026-09-09'),
        },
        { executor: tx },
      );

      expect(edited.id).toBe(row.id);
      expect(edited.name).toBe('Будни');
      expect(edited.weekday).toBe(3);

      expect(await readRows(fixture.admin, fixture.houseA, { executor: tx })).toHaveLength(1);
    });
  });

  it('пустое имя и день недели вне недели не принимаются', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9403');

      await expect(
        saveRow(fixture.admin, { ...commonRow(fixture), name: '   ' }, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        saveRow(fixture.admin, { ...commonRow(fixture), weekday: 7 }, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('дата старта обязана попадать на день недели ряда', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9404');

      await expect(
        saveRow(fixture.admin, { ...commonRow(fixture), startDate: SUNDAY }, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('жилец рядов не ведёт и не видит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9405');

      await expect(
        saveRow(fixture.resident, commonRow(fixture), { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        readRows(fixture.resident, fixture.houseA, { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('чужой дом неотличим от несуществующего: ряд в нём не заводится (P1-1)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9406');

      await expect(
        saveRow(
          fixture.admin,
          { ...commonRow(fixture), houseId: fixture.houseB },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('архивированный ряд из списка уходит, но остаётся в базе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9407');

      const row = await saveRow(fixture.admin, commonRow(fixture), { executor: tx });
      const archived = await archiveRow(fixture.admin, row.id, { executor: tx });

      expect(archived.isActive).toBe(false);
      expect(await readRows(fixture.admin, fixture.houseA, { executor: tx })).toEqual([]);
      expect(
        await readRows(fixture.admin, fixture.houseA, { executor: tx, includeInactive: true }),
      ).toHaveLength(1);
    });
  });
});

describe('комнатный ряд (§6.4)', () => {
  it('воскресенье и своя комната', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9421');

      const row = await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseA,
          name: 'Комната 1',
          type: 'room',
          weekday: 0,
          startDate: SUNDAY,
          roomAreaId: fixture.room1,
        },
        { executor: tx },
      );

      expect(row.type).toBe('room');
      expect(row.roomAreaId).toBe(fixture.room1);
    });
  });

  it('комнатный ряд не бывает в другой день недели', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9422');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Комната 1',
            type: 'room',
            weekday: 1,
            startDate: MONDAY,
            roomAreaId: fixture.room1,
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('комнате ряда положено быть жилой комнатой своего дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9423');
      const base = {
        houseId: fixture.houseA,
        name: 'Комната',
        type: 'room' as const,
        weekday: 0,
        startDate: SUNDAY,
      };

      // Без комнаты комнатный ряд не описан.
      await expect(saveRow(fixture.admin, base, { executor: tx })).rejects.toBeInstanceOf(
        ValidationError,
      );
      // Двор — не комната.
      await expect(
        saveRow(fixture.admin, { ...base, roomAreaId: fixture.yard }, { executor: tx }),
      ).rejects.toBeInstanceOf(ValidationError);
      // Комната соседнего дома неотличима от несуществующей (P1-1).
      await expect(
        saveRow(fixture.admin, { ...base, roomAreaId: fixture.roomB }, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
