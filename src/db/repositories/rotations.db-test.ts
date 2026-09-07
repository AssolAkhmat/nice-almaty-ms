import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { NotFoundError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import {
  createChecklist,
  createEligibilityGroup,
  createOccurrence,
  createRotationRow,
  listChecklists,
  listEligibilityGroups,
  listOccurrences,
  listRotationRows,
  listRowSlots,
  listRowZones,
  putTemplateSettings,
  readTemplateSettings,
  replaceRowSlots,
  replaceRowZones,
  requireRotationRow,
} from './rotations';

import type { AccessContext } from '../access';
import type { Database, Transaction } from '../client';

/**
 * Схема ротаций на настоящем PostgreSQL: уникальности рядов и занятий
 * действуют в базе, а не в коде, и проверяются там же. Видимость дома —
 * второе, что здесь проверяется: админ соседнего дома не должен узнать
 * даже, сколько у соседа рядов.
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

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }

  return parts.join(' | ');
}

/** Ожидаемо падающий запрос идёт во вложенной транзакции: внешняя остаётся живой. */
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

const MONDAY = parseBusinessDate('2026-09-07');

interface Fixture {
  orgId: string;
  houseA: string;
  houseB: string;
  roomA: string;
  yardA: string;
  roomB: string;
  bedsA: string[];
  superadmin: AccessContext;
  adminA: AccessContext;
  adminB: AccessContext;
}

async function seed(tx: Transaction, suffix: string): Promise<Fixture> {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rot-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `rot-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `rot-b-${suffix}` })
    .returning();

  const houseAId = houseA?.id ?? '';
  const houseBId = houseB?.id ?? '';

  const [roomA] = await tx
    .insert(schema.areas)
    .values({ houseId: houseAId, type: 'living', name: 'Комната 1' })
    .returning();
  const [yardA] = await tx
    .insert(schema.areas)
    .values({ houseId: houseAId, type: 'common', name: 'Двор' })
    .returning();
  const [roomB] = await tx
    .insert(schema.areas)
    .values({ houseId: houseBId, type: 'living', name: 'Комната соседа' })
    .returning();

  const beds = await tx
    .insert(schema.beds)
    .values([
      {
        houseId: houseAId,
        areaId: roomA?.id ?? '',
        label: 'A1',
        tier: 'lower' as const,
        number: 1,
      },
      {
        houseId: houseAId,
        areaId: roomA?.id ?? '',
        label: 'A2',
        tier: 'upper' as const,
        number: 2,
      },
    ])
    .returning();

  return {
    orgId,
    houseA: houseAId,
    houseB: houseBId,
    roomA: roomA?.id ?? '',
    yardA: yardA?.id ?? '',
    roomB: roomB?.id ?? '',
    bedsA: beds.map((bed) => bed.id),
    superadmin: {
      orgId,
      userId: '00000000-0000-0000-0000-000000000000',
      role: 'superadmin',
      houseId: null,
    },
    adminA: {
      orgId,
      userId: '00000000-0000-0000-0000-000000000001',
      role: 'admin',
      houseId: houseAId,
    },
    adminB: {
      orgId,
      userId: '00000000-0000-0000-0000-000000000002',
      role: 'admin',
      houseId: houseBId,
    },
  };
}

describe('чек-листы зон', () => {
  it('заводятся на зону и перечисляются по дому', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4201');

      await createChecklist(
        fixture.adminA,
        {
          areaId: fixture.yardA,
          type: 'regular',
          title: 'Двор',
          items: ['подмести', 'вынести мусор'],
          peopleNeeded: 2,
        },
        tx,
      );

      const list = await listChecklists(fixture.adminA, fixture.houseA, {}, tx);

      expect(list).toHaveLength(1);
      expect(list[0]?.peopleNeeded).toBe(2);
      expect(list[0]?.items).toEqual(['подмести', 'вынести мусор']);
    });
  });

  it('на зону два вида чек-листа, но не два одного вида', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4202');

      await createChecklist(
        fixture.adminA,
        { areaId: fixture.yardA, type: 'regular', title: 'Двор' },
        tx,
      );
      await createChecklist(
        fixture.adminA,
        { areaId: fixture.yardA, type: 'general', title: 'Двор, генеральная' },
        tx,
      );

      const text = await failureText(tx, (inner) =>
        createChecklist(
          fixture.adminA,
          { areaId: fixture.yardA, type: 'regular', title: 'Второй обычный' },
          inner,
        ),
      );

      expect(text).toContain('area_checklists_area_type_unique');
      expect(await listChecklists(fixture.adminA, fixture.houseA, {}, tx)).toHaveLength(2);
    });
  });

  it('чек-лист чужого дома завести нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4203');

      await expect(
        createChecklist(
          fixture.adminA,
          { areaId: fixture.roomB, type: 'regular', title: 'Комната соседа' },
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('список чужого дома неотличим от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4204');

      await expect(listChecklists(fixture.adminA, fixture.houseB, {}, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});

describe('группы допуска', () => {
  it('заводятся на дом и видны только своему дому', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4205');

      await createEligibilityGroup(
        fixture.adminA,
        {
          houseId: fixture.houseA,
          name: 'Двор: парни, кроме Азамата',
          rule: { base: 'male', excludeUserIds: [] },
        },
        tx,
      );

      const mine = await listEligibilityGroups(fixture.adminA, fixture.houseA, tx);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.orgId).toBe(fixture.orgId);

      await expect(
        listEligibilityGroups(fixture.adminB, fixture.houseA, tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('ряды ротаций', () => {
  it('ряд заводится вместе со слотами и зонами', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4206');
      const checklist = await createChecklist(
        fixture.adminA,
        { areaId: fixture.yardA, type: 'regular', title: 'Двор', peopleNeeded: 1 },
        tx,
      );

      const row = await createRotationRow(
        fixture.adminA,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
        },
        tx,
      );

      await replaceRowSlots(
        fixture.adminA,
        row.id,
        [
          { position: 0, bedId: fixture.bedsA[0] ?? '' },
          { position: 1, bedId: fixture.bedsA[1] ?? '' },
        ],
        tx,
      );
      await replaceRowZones(
        fixture.adminA,
        row.id,
        [{ position: 0, areaId: fixture.yardA, checklistId: checklist.id, peopleNeeded: 1 }],
        tx,
      );

      expect((await listRowSlots(fixture.adminA, row.id, tx)).map((slot) => slot.position)).toEqual(
        [0, 1],
      );
      expect(await listRowZones(fixture.adminA, row.id, tx)).toHaveLength(1);
      expect((await requireRotationRow(fixture.adminA, row.id, tx)).orgId).toBe(fixture.orgId);
    });
  });

  it('повторная сборка ряда заменяет слоты, а не добавляет вторые', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4207');
      const row = await createRotationRow(
        fixture.adminA,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
        },
        tx,
      );

      await replaceRowSlots(
        fixture.adminA,
        row.id,
        [
          { position: 0, bedId: fixture.bedsA[0] ?? '' },
          { position: 1, bedId: fixture.bedsA[1] ?? '' },
        ],
        tx,
      );
      await replaceRowSlots(
        fixture.adminA,
        row.id,
        [{ position: 0, bedId: fixture.bedsA[1] ?? '' }],
        tx,
      );

      const slots = await listRowSlots(fixture.adminA, row.id, tx);
      expect(slots).toHaveLength(1);
      expect(slots[0]?.bedId).toBe(fixture.bedsA[1]);
    });
  });

  it('две позиции с одним номером в базу не проходят', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4208');
      const row = await createRotationRow(
        fixture.adminA,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
        },
        tx,
      );

      const text = await failureText(tx, (inner) =>
        inner.insert(schema.rotationRowSlots).values([
          { rowId: row.id, position: 0, bedId: fixture.bedsA[0] ?? '' },
          { rowId: row.id, position: 0, bedId: fixture.bedsA[1] ?? '' },
        ]),
      );

      expect(text).toContain('rotation_row_slots_position_unique');
    });
  });

  it('одно место дважды в ряду не стоит: иначе жилец получил бы две зоны за неделю', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4209');
      const row = await createRotationRow(
        fixture.adminA,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
        },
        tx,
      );

      const text = await failureText(tx, (inner) =>
        inner.insert(schema.rotationRowSlots).values([
          { rowId: row.id, position: 0, bedId: fixture.bedsA[0] ?? '' },
          { rowId: row.id, position: 1, bedId: fixture.bedsA[0] ?? '' },
        ]),
      );

      expect(text).toContain('rotation_row_slots_bed_unique');
    });
  });

  it('ряды чужого дома не перечисляются и не открываются', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4210');
      const row = await createRotationRow(
        fixture.adminA,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
        },
        tx,
      );

      await expect(listRotationRows(fixture.adminB, fixture.houseA, {}, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(requireRotationRow(fixture.adminB, row.id, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('ряд в чужом доме не заводится', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4211');

      await expect(
        createRotationRow(
          fixture.adminA,
          { houseId: fixture.houseB, name: 'Чужой', type: 'common', weekday: 1, startDate: MONDAY },
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('занятия', () => {
  it('перечисляются за период и только по своему дому', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4212');
      const checklist = await createChecklist(
        fixture.adminA,
        { areaId: fixture.yardA, type: 'regular', title: 'Двор' },
        tx,
      );
      const row = await createRotationRow(
        fixture.adminA,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
        },
        tx,
      );

      await createOccurrence(
        fixture.adminA,
        {
          houseId: fixture.houseA,
          rowId: row.id,
          areaId: fixture.yardA,
          checklistId: checklist.id,
          date: MONDAY,
          type: 'regular',
          cycleIndex: 0,
        },
        tx,
      );

      const inRange = await listOccurrences(
        fixture.adminA,
        fixture.houseA,
        { from: MONDAY, to: parseBusinessDate('2026-09-13') },
        tx,
      );
      const outOfRange = await listOccurrences(
        fixture.adminA,
        fixture.houseA,
        { from: parseBusinessDate('2026-09-08'), to: parseBusinessDate('2026-09-13') },
        tx,
      );

      expect(inRange).toHaveLength(1);
      expect(outOfRange).toHaveLength(0);
      await expect(
        listOccurrences(
          fixture.adminB,
          fixture.houseA,
          { from: MONDAY, to: parseBusinessDate('2026-09-13') },
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('повторная генерация того же дня не создаёт второго занятия', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4213');
      const checklist = await createChecklist(
        fixture.adminA,
        { areaId: fixture.yardA, type: 'regular', title: 'Двор' },
        tx,
      );
      const row = await createRotationRow(
        fixture.adminA,
        {
          houseId: fixture.houseA,
          name: 'Общие зоны',
          type: 'common',
          weekday: 1,
          startDate: MONDAY,
        },
        tx,
      );

      const input = {
        houseId: fixture.houseA,
        rowId: row.id,
        areaId: fixture.yardA,
        checklistId: checklist.id,
        date: MONDAY,
        type: 'regular' as const,
        cycleIndex: 0,
      };

      await createOccurrence(fixture.adminA, input, tx);
      const text = await failureText(tx, (inner) => createOccurrence(fixture.adminA, input, inner));

      expect(text).toContain('rotation_occurrences_row_area_date_unique');
    });
  });

  it('внеплановые занятия без ряда под уникальность дня не попадают', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4214');
      const checklist = await createChecklist(
        fixture.adminA,
        { areaId: fixture.yardA, type: 'regular', title: 'Двор' },
        tx,
      );

      const extra = {
        houseId: fixture.houseA,
        areaId: fixture.yardA,
        checklistId: checklist.id,
        date: MONDAY,
        type: 'extra' as const,
      };

      await createOccurrence(fixture.adminA, extra, tx);
      await createOccurrence(fixture.adminA, extra, tx);

      const list = await listOccurrences(
        fixture.adminA,
        fixture.houseA,
        { from: MONDAY, to: MONDAY },
        tx,
      );

      expect(list).toHaveLength(2);
    });
  });
});

describe('шаблоны текста для группы', () => {
  it('хранятся по дому и виду уборки, повторная запись обновляет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4215');

      await putTemplateSettings(
        fixture.adminA,
        fixture.houseA,
        'regular',
        { headerI18n: { ru: 'Дежурства на' }, footerI18n: { ru: 'Спасибо' } },
        tx,
      );
      await putTemplateSettings(
        fixture.adminA,
        fixture.houseA,
        'regular',
        { headerI18n: { ru: 'Уборка на' }, footerI18n: { ru: 'Спасибо' } },
        tx,
      );

      const settings = await readTemplateSettings(fixture.adminA, fixture.houseA, 'regular', tx);

      expect(settings?.headerI18n).toEqual({ ru: 'Уборка на' });
    });
  });

  it('шаблон чужого дома не пишется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4216');

      await expect(
        putTemplateSettings(
          fixture.adminA,
          fixture.houseB,
          'general',
          { headerI18n: {}, footerI18n: {} },
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
