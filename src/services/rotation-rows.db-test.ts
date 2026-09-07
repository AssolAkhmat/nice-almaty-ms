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
 * Ряды ротаций (docs/03-BUSINESS-RULES.md §6.1, §6.4).
 *
 * Ряд собирается из мест и зон своего дома, а инвариант 9 (`D <= S`)
 * проверяется той же формулой, по которой потом считается сетка.
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
  const room2 = await area(houseAId, 'Комната 2', 'living');
  const yard = await area(houseAId, 'Двор', 'common');
  const kitchen = await area(houseAId, 'Кухня', 'common');
  const roomB = await area(houseBId, 'Комната соседа', 'living');

  async function bed(houseId: string, areaId: string, number: number): Promise<string> {
    const [row] = await tx
      .insert(schema.beds)
      .values({ houseId, areaId, label: `М${number}`, tier: 'lower', number })
      .returning();

    return row?.id ?? '';
  }

  const bed1 = await bed(houseAId, room1, 1);
  const bed2 = await bed(houseAId, room1, 2);
  const bed3 = await bed(houseAId, room2, 3);
  const bedB = await bed(houseBId, roomB, 4);

  async function checklist(
    areaId: string,
    peopleNeeded: number,
    type: 'regular' | 'general' = 'regular',
  ): Promise<string> {
    const [row] = await tx
      .insert(schema.areaChecklists)
      .values({ areaId, type, title: 'Уборка', peopleNeeded })
      .returning();

    return row?.id ?? '';
  }

  const yardChecklist = await checklist(yard, 2);
  const kitchenChecklist = await checklist(kitchen, 1);
  const room1Checklist = await checklist(room1, 1);
  const roomBChecklist = await checklist(roomB, 1);

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
    room2,
    yard,
    kitchen,
    roomB,
    bed1,
    bed2,
    bed3,
    bedB,
    yardChecklist,
    kitchenChecklist,
    room1Checklist,
    roomBChecklist,
    admin: actor(context('admin', adminUser?.id ?? '', houseAId)),
    resident: actor(context('resident', residentUser?.id ?? '', null)),
  };
}

describe('ряд общих зон', () => {
  it('заводится со слотами и зонами и читается целиком', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9401');

      const row = await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
          slots: [{ bedId: fixture.bed1 }, { bedId: fixture.bed2 }, { bedId: fixture.bed3 }],
          zones: [
            { areaId: fixture.yard, checklistId: fixture.yardChecklist },
            { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
          ],
        },
        { executor: tx },
      );

      const [view] = await readRows(fixture.admin, fixture.houseA, { executor: tx });

      expect(view?.row.id).toBe(row.id);
      expect(view?.slots.map((slot) => slot.position)).toEqual([0, 1, 2]);
      expect(view?.slots.map((slot) => slot.bedId)).toEqual([
        fixture.bed1,
        fixture.bed2,
        fixture.bed3,
      ]);
      // people_needed переезжает из чек-листа: ряд проверяется без обращения к нему.
      expect(view?.zones.map((zone) => zone.peopleNeeded)).toEqual([2, 1]);
    });
  });

  it('сумма people_needed больше числа слотов — отказ (инвариант 9)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9402');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Тесный ряд',
            type: 'common',
            weekday: 1,
            startDate: MONDAY,
            // Двор требует двоих, кухня одного: троих обязанностей на два места.
            slots: [{ bedId: fixture.bed1 }, { bedId: fixture.bed2 }],
            zones: [
              { areaId: fixture.yard, checklistId: fixture.yardChecklist },
              { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
            ],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await readRows(fixture.admin, fixture.houseA, { executor: tx })).toHaveLength(0);
    });
  });

  it('ровно по числу слотов — ряд без отдыха допустим', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9403');

      const row = await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseA,
          name: 'Без отдыха',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
          slots: [{ bedId: fixture.bed1 }, { bedId: fixture.bed2 }, { bedId: fixture.bed3 }],
          zones: [
            { areaId: fixture.yard, checklistId: fixture.yardChecklist },
            { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
          ],
        },
        { executor: tx },
      );

      expect(row.isActive).toBe(true);
    });
  });

  it('ряд без слотов и ряд без зон не сохраняются', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9404');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Пустой',
            type: 'common',
            weekday: 1,
            startDate: MONDAY,
            slots: [],
            zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Без зон',
            type: 'common',
            weekday: 1,
            startDate: MONDAY,
            slots: [{ bedId: fixture.bed1 }],
            zones: [],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('день недели вне недели не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9405');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Восьмой день',
            type: 'common',
            weekday: 7,
            startDate: MONDAY,
            slots: [{ bedId: fixture.bed1 }],
            zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('дата старта обязана попадать на день недели ряда', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9406');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Понедельник в воскресенье',
            type: 'common',
            weekday: 1,
            startDate: SUNDAY,
            slots: [{ bedId: fixture.bed1 }],
            zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('место и зона чужого дома в ряд не попадают', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9407');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Чужое место',
            type: 'common',
            weekday: 1,
            startDate: MONDAY,
            slots: [{ bedId: fixture.bedB }],
            zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Чужая зона',
            type: 'common',
            weekday: 1,
            startDate: MONDAY,
            slots: [{ bedId: fixture.bed1 }],
            zones: [{ areaId: fixture.roomB, checklistId: fixture.roomBChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('одно место дважды в ряду не стоит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9408');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Дубль',
            type: 'common',
            weekday: 1,
            startDate: MONDAY,
            slots: [{ bedId: fixture.bed1 }, { bedId: fixture.bed1 }],
            zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('чек-лист чужой зоны к зоне ряда не привязывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9409');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Чужой чек-лист',
            type: 'common',
            weekday: 1,
            startDate: MONDAY,
            slots: [{ bedId: fixture.bed1 }],
            zones: [{ areaId: fixture.kitchen, checklistId: fixture.yardChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('правка ряда заменяет слоты и зоны целиком', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9410');

      const row = await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
          slots: [{ bedId: fixture.bed1 }, { bedId: fixture.bed2 }, { bedId: fixture.bed3 }],
          zones: [
            { areaId: fixture.yard, checklistId: fixture.yardChecklist },
            { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
          ],
        },
        { executor: tx },
      );

      await saveRow(
        fixture.admin,
        {
          rowId: row.id,
          houseId: fixture.houseA,
          name: 'Только кухня',
          type: 'common',
          weekday: 2,
          startDate: parseBusinessDate('2026-09-08'),
          slots: [{ bedId: fixture.bed3 }, { bedId: fixture.bed1 }],
          zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
        },
        { executor: tx },
      );

      const rows = await readRows(fixture.admin, fixture.houseA, { executor: tx });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.row.name).toBe('Только кухня');
      expect(rows[0]?.row.weekday).toBe(2);
      expect(rows[0]?.slots.map((slot) => slot.bedId)).toEqual([fixture.bed3, fixture.bed1]);
      expect(rows[0]?.zones).toHaveLength(1);
    });
  });

  it('жилец рядов не ведёт и не видит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9411');

      await expect(
        saveRow(
          fixture.resident,
          {
            houseId: fixture.houseA,
            name: 'Свой ряд',
            type: 'common',
            weekday: 1,
            startDate: MONDAY,
            slots: [{ bedId: fixture.bed1 }],
            zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        readRows(fixture.resident, fixture.houseA, { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('архивированный ряд из списка уходит, а его слоты остаются нетронутыми', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9412');

      const row = await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
          slots: [{ bedId: fixture.bed1 }],
          zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
        },
        { executor: tx },
      );

      await archiveRow(fixture.admin, row.id, { executor: tx });

      expect(await readRows(fixture.admin, fixture.houseA, { executor: tx })).toHaveLength(0);

      const all = await readRows(fixture.admin, fixture.houseA, {
        executor: tx,
        includeInactive: true,
      });
      expect(all[0]?.slots).toHaveLength(1);
    });
  });
});

describe('комнатный ряд (§6.4)', () => {
  it('воскресенье, места комнаты и одна зона — сама комната', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9420');

      const row = await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseA,
          name: 'Комната 1',
          type: 'room',
          weekday: 0,
          startDate: SUNDAY,
          slots: [{ bedId: fixture.bed1 }, { bedId: fixture.bed2 }],
          zones: [{ areaId: fixture.room1, checklistId: fixture.room1Checklist }],
        },
        { executor: tx },
      );

      expect(row.type).toBe('room');
      expect(row.weekday).toBe(0);
    });
  });

  it('комнатный ряд не бывает в другой день недели', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9421');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Комната по вторникам',
            type: 'room',
            weekday: 2,
            startDate: parseBusinessDate('2026-09-08'),
            slots: [{ bedId: fixture.bed1 }],
            zones: [{ areaId: fixture.room1, checklistId: fixture.room1Checklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('у комнатного ряда ровно одна зона', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9422');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Комната и двор',
            type: 'room',
            weekday: 0,
            startDate: SUNDAY,
            slots: [{ bedId: fixture.bed1 }, { bedId: fixture.bed2 }],
            zones: [
              { areaId: fixture.room1, checklistId: fixture.room1Checklist },
              { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
            ],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('слоты комнатного ряда — места этой же комнаты', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9423');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Комната 1',
            type: 'room',
            weekday: 0,
            startDate: SUNDAY,
            // bed3 стоит в комнате 2, а зона ряда — комната 1.
            slots: [{ bedId: fixture.bed1 }, { bedId: fixture.bed3 }],
            zones: [{ areaId: fixture.room1, checklistId: fixture.room1Checklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('зона комнатного ряда — жилая комната, а не общая зона', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9424');

      await expect(
        saveRow(
          fixture.admin,
          {
            houseId: fixture.houseA,
            name: 'Кухня как комната',
            type: 'room',
            weekday: 0,
            startDate: SUNDAY,
            slots: [{ bedId: fixture.bed1 }],
            zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe('слот держится места, а не человека', () => {
  it('смена жильца места не двигает позицию в цикле', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9430');

      const row = await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
          slots: [{ bedId: fixture.bed1 }, { bedId: fixture.bed2 }],
          zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
        },
        { executor: tx },
      );

      const before = await readRows(fixture.admin, fixture.houseA, { executor: tx });

      // Жилец въезжает на первое место ряда — состав ряда от этого не меняется.
      const [user] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77099430001',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();
      const [residency] = await tx
        .insert(schema.residencies)
        .values({
          orgId: fixture.orgId,
          userId: user?.id ?? '',
          houseId: fixture.houseA,
          status: 'active',
          moveInDate: '2026-09-01',
        })
        .returning();
      await tx.insert(schema.bedAssignments).values({
        residencyId: residency?.id ?? '',
        bedId: fixture.bed1,
        price: 100_000,
        period: '[2026-09-01,)',
      });

      const after = await readRows(fixture.admin, fixture.houseA, { executor: tx });

      expect(after[0]?.row.id).toBe(row.id);
      expect(after[0]?.slots.map((slot) => `${String(slot.position)}:${slot.bedId}`)).toEqual(
        before[0]?.slots.map((slot) => `${String(slot.position)}:${slot.bedId}`),
      );
    });
  });
});
