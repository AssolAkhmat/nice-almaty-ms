import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { eq } from 'drizzle-orm';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { NotFoundError, ValidationError } from '@/lib/errors';

import { parseBusinessDate } from '@/lib/time';

import { previewRotationDays, readDaySetup, saveNorm, saveRoster } from './rotation-day-setup';
import { generateSchedule, readSchedule } from './rotation-schedule';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Настройка ротаций фазы 10: состав ряда и норма дня — две версионируемые
 * сущности (`docs/tasks/PHASE-10.md` §2.2, §2.3), предпросмотр считает
 * их формулой §2.4 через `src/domain/rotation-day.ts`.
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

/** Среда: с неё стартует ряд общих зон в примерах §3. */
const WEDNESDAY = parseBusinessDate('2026-09-09');
/** Воскресенье: день комнатных рядов (§6.4). */
const SUNDAY = parseBusinessDate('2026-09-06');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `setup-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `setup-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `setup-b-${suffix}` })
    .returning();
  const houseId = houseA?.id ?? '';
  const otherHouseId = houseB?.id ?? '';

  async function area(house: string, name: string, type: 'living' | 'common'): Promise<string> {
    const [row] = await tx.insert(schema.areas).values({ houseId: house, type, name }).returning();

    return row?.id ?? '';
  }

  const room = await area(houseId, 'Комната 1', 'living');
  const secondRoom = await area(houseId, 'Комната 2', 'living');
  const yard = await area(houseId, 'Двор', 'common');
  const kitchen = await area(houseId, 'Кухня', 'common');
  const otherYard = await area(otherHouseId, 'Двор соседа', 'common');

  async function bed(house: string, areaId: string, number: number): Promise<string> {
    const [row] = await tx
      .insert(schema.beds)
      .values({ houseId: house, areaId, label: `М${number}`, tier: 'lower', number })
      .returning();

    return row?.id ?? '';
  }

  const bed1 = await bed(houseId, room, 1);
  const bed2 = await bed(houseId, room, 2);
  const bed3 = await bed(houseId, secondRoom, 3);
  const otherBed = await bed(otherHouseId, otherYard, 4);

  async function checklist(areaId: string, peopleNeeded: number): Promise<string> {
    const [row] = await tx
      .insert(schema.areaChecklists)
      .values({ areaId, type: 'regular', title: 'Уборка', peopleNeeded })
      .returning();

    return row?.id ?? '';
  }

  const yardChecklist = await checklist(yard, 2);
  const kitchenChecklist = await checklist(kitchen, 1);
  const roomChecklist = await checklist(room, 1);
  const otherChecklist = await checklist(otherYard, 1);

  async function row(values: Partial<schema.NewRotationRow> & { name: string }): Promise<string> {
    const [created] = await tx
      .insert(schema.rotationRows)
      .values({
        orgId,
        houseId,
        type: 'common',
        weekday: 3,
        startDate: WEDNESDAY,
        ...values,
      })
      .returning();

    return created?.id ?? '';
  }

  const commonRow = await row({ name: 'Среда' });
  const roomRow = await row({
    name: 'Комната 1',
    type: 'room',
    weekday: 0,
    startDate: SUNDAY,
    roomAreaId: room,
  });

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();
  const [otherAdmin] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7708${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: otherHouseId,
    })
    .returning();

  /** Селит жильца на место: без этого предпросмотр видит пустое место. */
  async function live(bedId: string, index: number): Promise<string> {
    const [user] = await tx
      .insert(schema.users)
      .values({
        orgId,
        phone: `+7705${suffix}${String(index)}`,
        passwordHash: 'x',
        role: 'resident',
      })
      .returning();
    const [residency] = await tx
      .insert(schema.residencies)
      .values({
        orgId,
        userId: user?.id ?? '',
        houseId,
        status: 'active',
        moveInDate: parseBusinessDate('2026-09-01'),
      })
      .returning();

    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId,
      price: 100_000,
      period: '[2026-09-01,)',
    });

    return user?.id ?? '';
  }

  const context = (
    role: AccessContext['role'],
    userId: string,
    house: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: house });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseId,
    otherHouseId,
    room,
    secondRoom,
    yard,
    kitchen,
    otherYard,
    bed1,
    bed2,
    bed3,
    otherBed,
    yardChecklist,
    kitchenChecklist,
    roomChecklist,
    otherChecklist,
    commonRow,
    roomRow,
    live,
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    otherAdmin: actor(context('admin', otherAdmin?.id ?? '', otherHouseId)),
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

function rosterOf(fixture: Fixture, bedIds: readonly string[], effectiveFrom = WEDNESDAY) {
  return { rowId: fixture.commonRow, effectiveFrom, bedIds };
}

describe('состав ряда', () => {
  it('сохраняется версией с датой вступления, места стоят по порядку', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9601');

      const version = await saveRoster(
        fixture.admin,
        rosterOf(fixture, [fixture.bed1, fixture.bed2, fixture.bed3]),
        { executor: tx },
      );

      expect(version.version.effectiveFrom).toBe(WEDNESDAY);
      expect(version.version.bedIds).toEqual([fixture.bed1, fixture.bed2, fixture.bed3]);
    });
  });

  it('правка на ту же дату заменяет состав, а не заводит вторую версию', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9602');

      await saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed1, fixture.bed2]), {
        executor: tx,
      });
      await saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed2, fixture.bed1]), {
        executor: tx,
      });

      const setup = await readDaySetup(fixture.admin, fixture.houseId, { executor: tx });
      const row = setup.rows.find((item) => item.row.id === fixture.commonRow);

      expect(row?.rosters).toHaveLength(1);
      expect(row?.rosters[0]?.bedIds).toEqual([fixture.bed2, fixture.bed1]);
    });
  });

  it('правка с новой даты живёт рядом с прежней версией', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9603');

      await saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed1]), { executor: tx });
      await saveRoster(
        fixture.admin,
        rosterOf(fixture, [fixture.bed1, fixture.bed2], parseBusinessDate('2026-10-21')),
        { executor: tx },
      );

      const setup = await readDaySetup(fixture.admin, fixture.houseId, { executor: tx });
      const row = setup.rows.find((item) => item.row.id === fixture.commonRow);

      expect(row?.rosters.map((version) => version.effectiveFrom)).toEqual([
        '2026-09-09',
        '2026-10-21',
      ]);
    });
  });

  it('одно место дважды в составе — отказ: жилец получил бы две зоны за день', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9604');

      await expect(
        saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed1, fixture.bed1]), {
          executor: tx,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('место чужого дома в составе не оказывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9605');

      await expect(
        saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed1, fixture.otherBed]), {
          executor: tx,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('дата вступления раньше старта ряда — отказ: до старта сетки нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9606');

      await expect(
        saveRoster(
          fixture.admin,
          rosterOf(fixture, [fixture.bed1], parseBusinessDate('2026-09-02')),
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('комнатный ряд берёт места только своей комнаты', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9607');

      await expect(
        saveRoster(
          fixture.admin,
          { rowId: fixture.roomRow, effectiveFrom: SUNDAY, bedIds: [fixture.bed3] },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // Чужой дом неотличим от несуществующего (P1-1): отказ приходит «не найдено».
  it('админ чужого дома состав не правит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9608');

      await expect(
        saveRoster(fixture.otherAdmin, rosterOf(fixture, [fixture.bed1]), { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('сохранение состава попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9609');

      await saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed1]), { executor: tx });

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, fixture.commonRow));

      expect(entries.map((entry) => entry.action)).toContain('rotation_roster.saved');
    });
  });
});

describe('норма дня', () => {
  it('сохраняется с зонами по порядку, число людей берётся из чек-листа', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9621');

      const norm = await saveNorm(
        fixture.admin,
        {
          rowId: fixture.commonRow,
          effectiveFrom: WEDNESDAY,
          zones: [
            { areaId: fixture.yard, checklistId: fixture.yardChecklist },
            { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
          ],
        },
        { executor: tx },
      );

      expect(norm.version.zones.map((zone) => zone.areaId)).toEqual([
        fixture.yard,
        fixture.kitchen,
      ]);
      expect(norm.version.zones.map((zone) => zone.people)).toEqual([2, 1]);
    });
  });

  it('число людей зоны задаётся нормой и чек-листу не подчиняется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9622');

      const norm = await saveNorm(
        fixture.admin,
        {
          rowId: fixture.commonRow,
          effectiveFrom: WEDNESDAY,
          zones: [{ areaId: fixture.yard, checklistId: fixture.yardChecklist, people: 1 }],
        },
        { executor: tx },
      );

      expect(norm.version.zones[0]?.people).toBe(1);
    });
  });

  it('чек-лист чужой зоны — отказ: убирают одно, спрашивают другое', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9623');

      await expect(
        saveNorm(
          fixture.admin,
          {
            rowId: fixture.commonRow,
            effectiveFrom: WEDNESDAY,
            zones: [{ areaId: fixture.yard, checklistId: fixture.kitchenChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('зона чужого дома в норму не попадает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9624');

      await expect(
        saveNorm(
          fixture.admin,
          {
            rowId: fixture.commonRow,
            effectiveFrom: WEDNESDAY,
            zones: [{ areaId: fixture.otherYard, checklistId: fixture.otherChecklist }],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('норма комнатного ряда — одна зона, сама комната', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9625');

      await expect(
        saveNorm(
          fixture.admin,
          {
            rowId: fixture.roomRow,
            effectiveFrom: SUNDAY,
            zones: [
              { areaId: fixture.room, checklistId: fixture.roomChecklist },
              { areaId: fixture.yard, checklistId: fixture.yardChecklist },
            ],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe('чтение настройки дома', () => {
  it('места вне действующих составов перечислены отдельно', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9641');

      await saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed1, fixture.bed2]), {
        executor: tx,
      });

      const setup = await readDaySetup(fixture.admin, fixture.houseId, { executor: tx });

      expect(setup.bedsOutsideRows).toEqual([fixture.bed3]);
    });
  });

  it('место в составах двух рядов — предупреждение, а не запрет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9642');

      await saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed1, fixture.bed2]), {
        executor: tx,
      });
      await saveRoster(
        fixture.admin,
        { rowId: fixture.roomRow, effectiveFrom: SUNDAY, bedIds: [fixture.bed1] },
        { executor: tx },
      );

      const setup = await readDaySetup(fixture.admin, fixture.houseId, { executor: tx });

      // Порядок рядов в предупреждении — тот же, в каком они идут на экране.
      expect(setup.bedsInSeveralRows).toEqual([
        { bedId: fixture.bed1, rowIds: [fixture.roomRow, fixture.commonRow] },
      ]);
    });
  });

  it('админ чужого дома настройку не читает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9643');

      await expect(
        readDaySetup(fixture.otherAdmin, fixture.houseId, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('предпросмотр', () => {
  it('четыре недели вперёд: зоны сдвигаются на шаг в неделю', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9661');
      await fixture.live(fixture.bed1, 1);
      await fixture.live(fixture.bed2, 2);

      await saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed1, fixture.bed2]), {
        executor: tx,
      });
      await saveNorm(
        fixture.admin,
        {
          rowId: fixture.commonRow,
          effectiveFrom: WEDNESDAY,
          zones: [
            { areaId: fixture.yard, checklistId: fixture.yardChecklist, people: 1 },
            { areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist },
          ],
        },
        { executor: tx },
      );

      const days = await previewRotationDays(
        fixture.admin,
        { rowId: fixture.commonRow, from: WEDNESDAY },
        { executor: tx },
      );

      expect(days).toHaveLength(4);
      expect(days.map((day) => day.date)).toEqual([
        '2026-09-09',
        '2026-09-16',
        '2026-09-23',
        '2026-09-30',
      ]);
      expect(days[0]?.assignments.map((item) => item.areaId)).toEqual([
        fixture.yard,
        fixture.kitchen,
      ]);
      // Неделя 1: тот же жилец переходит с двора на кухню.
      expect(days[0]?.assignments[0]?.userId).toBe(days[1]?.assignments[1]?.userId);
    });
  });

  it('пустое место в составе даёт дырку с причиной', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9662');

      await saveRoster(fixture.admin, rosterOf(fixture, [fixture.bed1]), { executor: tx });
      await saveNorm(
        fixture.admin,
        {
          rowId: fixture.commonRow,
          effectiveFrom: WEDNESDAY,
          zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
        },
        { executor: tx },
      );

      const [day] = await previewRotationDays(
        fixture.admin,
        { rowId: fixture.commonRow, from: WEDNESDAY, weeks: 1 },
        { executor: tx },
      );

      expect(day?.assignments[0]?.userId).toBeNull();
      expect(day?.assignments[0]?.emptyReason).toBe('empty_bed');
    });
  });

  it('считает по черновику: правку видно до сохранения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9663');
      await fixture.live(fixture.bed1, 1);

      const [day] = await previewRotationDays(
        fixture.admin,
        {
          rowId: fixture.commonRow,
          from: WEDNESDAY,
          weeks: 1,
          draftRoster: { effectiveFrom: WEDNESDAY, bedIds: [fixture.bed1] },
          draftNorm: {
            effectiveFrom: WEDNESDAY,
            zones: [{ areaId: fixture.yard, checklistId: fixture.yardChecklist, people: 1 }],
          },
        },
        { executor: tx },
      );

      expect(day?.assignments.map((item) => item.areaId)).toEqual([fixture.yard]);
      expect(day?.assignments[0]?.userId).not.toBeNull();
    });
  });

  it('людей больше, чем зон: лишние показаны отдыхающими', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9664');
      await fixture.live(fixture.bed1, 1);
      await fixture.live(fixture.bed2, 2);

      const [day] = await previewRotationDays(
        fixture.admin,
        {
          rowId: fixture.commonRow,
          from: WEDNESDAY,
          weeks: 1,
          draftRoster: { effectiveFrom: WEDNESDAY, bedIds: [fixture.bed1, fixture.bed2] },
          draftNorm: {
            effectiveFrom: WEDNESDAY,
            zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
          },
        },
        { executor: tx },
      );

      expect(day?.resting.map((slot) => slot.bedId)).toEqual([fixture.bed2]);
    });
  });

  it('без состава или нормы предпросмотр пуст, а не выдуман', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9665');

      const days = await previewRotationDays(
        fixture.admin,
        { rowId: fixture.commonRow, from: WEDNESDAY },
        { executor: tx },
      );

      expect(days).toEqual([]);
    });
  });
});

/**
 * Правка «с даты» пересобирает будущие занятия ряда (§2.6): нетронутые
 * заводятся заново по новой версии, тронутые руками остаются и перечисляются.
 */
describe('пересборка будущих занятий', () => {
  const FIRST = parseBusinessDate('2026-09-16');
  const SECOND = parseBusinessDate('2026-09-23');
  const THIRD = parseBusinessDate('2026-09-30');
  /** «Сегодня» прогона: 16 сентября уже впереди, прошлого в горизонте нет. */
  const TODAY = parseBusinessDate('2026-09-14');

  async function scheduled(tx: Transaction, fixture: Fixture) {
    await saveRoster(
      fixture.admin,
      { rowId: fixture.commonRow, effectiveFrom: WEDNESDAY, bedIds: [fixture.bed1] },
      { executor: tx },
    );
    await saveNorm(
      fixture.admin,
      {
        rowId: fixture.commonRow,
        effectiveFrom: WEDNESDAY,
        zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenChecklist }],
      },
      { executor: tx },
    );

    await generateSchedule(fixture.admin, fixture.houseId, THIRD, {
      executor: tx,
      today: TODAY,
    });

    return readSchedule(
      fixture.admin,
      fixture.houseId,
      { from: FIRST, to: THIRD },
      { executor: tx },
    );
  }

  it('нетронутые занятия с даты правки заводятся заново по новому составу', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9681');
      const first = await fixture.live(fixture.bed1, 1);
      const second = await fixture.live(fixture.bed2, 2);

      expect((await scheduled(tx, fixture)).map((day) => day.assignments[0]?.userId)).toEqual([
        first,
        first,
        first,
      ]);

      const result = await saveRoster(
        fixture.admin,
        { rowId: fixture.commonRow, effectiveFrom: SECOND, bedIds: [fixture.bed2] },
        { executor: tx, today: TODAY },
      );

      expect(result.rebuilt).toBe(2);
      expect(result.kept).toEqual([]);

      const days = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: FIRST, to: THIRD },
        { executor: tx },
      );

      expect(days.map((day) => day.assignments[0]?.userId)).toEqual([first, second, second]);
    });
  });

  it('занятие с ручной правкой остаётся и попадает в отчёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9682');
      const first = await fixture.live(fixture.bed1, 1);
      await fixture.live(fixture.bed2, 2);

      const days = await scheduled(tx, fixture);
      const third = days.find((day) => day.occurrence.date === THIRD);

      // Админ поменял исполнителя руками: такое занятие пересборка не трогает.
      await tx
        .update(schema.rotationAssignments)
        .set({ source: 'manual' })
        .where(eq(schema.rotationAssignments.id, third?.assignments[0]?.id ?? ''));

      const result = await saveRoster(
        fixture.admin,
        { rowId: fixture.commonRow, effectiveFrom: SECOND, bedIds: [fixture.bed2] },
        { executor: tx, today: TODAY },
      );

      expect(result.rebuilt).toBe(1);
      expect(result.kept).toEqual([{ date: THIRD, areaId: fixture.kitchen }]);

      const after = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: THIRD, to: THIRD },
        { executor: tx },
      );

      expect(after[0]?.assignments[0]?.userId).toBe(first);
    });
  });

  it('отменённое занятие пересборка не воскрешает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9683');
      await fixture.live(fixture.bed1, 1);
      await fixture.live(fixture.bed2, 2);

      const days = await scheduled(tx, fixture);
      const second = days.find((day) => day.occurrence.date === SECOND);

      await tx
        .update(schema.rotationOccurrences)
        .set({ status: 'cancelled' })
        .where(eq(schema.rotationOccurrences.id, second?.occurrence.id ?? ''));

      const result = await saveRoster(
        fixture.admin,
        { rowId: fixture.commonRow, effectiveFrom: SECOND, bedIds: [fixture.bed2] },
        { executor: tx, today: TODAY },
      );

      expect(result.kept.map((item) => item.date)).toContain(SECOND);

      const after = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: SECOND, to: SECOND },
        { executor: tx },
      );

      expect(after).toHaveLength(1);
      expect(after[0]?.occurrence.status).toBe('cancelled');
    });
  });

  it('прошлое не пересобирается: правка с прошлой даты трогает только будущее', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9684');
      const first = await fixture.live(fixture.bed1, 1);
      await fixture.live(fixture.bed2, 2);

      await scheduled(tx, fixture);

      const result = await saveRoster(
        fixture.admin,
        { rowId: fixture.commonRow, effectiveFrom: WEDNESDAY, bedIds: [fixture.bed2] },
        // «Сегодня» прогона — после первого занятия: оно уже прошло.
        { executor: tx, today: parseBusinessDate('2026-09-17') },
      );

      expect(result.rebuilt).toBe(2);

      const days = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: FIRST, to: FIRST },
        { executor: tx },
      );

      expect(days[0]?.assignments[0]?.userId).toBe(first);
    });
  });

  it('правка нормы пересобирает занятия так же, как правка состава', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9685');
      await fixture.live(fixture.bed1, 1);

      await scheduled(tx, fixture);

      const result = await saveNorm(
        fixture.admin,
        {
          rowId: fixture.commonRow,
          effectiveFrom: SECOND,
          zones: [{ areaId: fixture.yard, checklistId: fixture.yardChecklist, people: 1 }],
        },
        { executor: tx, today: TODAY },
      );

      expect(result.rebuilt).toBe(2);

      const days = await readSchedule(
        fixture.admin,
        fixture.houseId,
        { from: SECOND, to: SECOND },
        { executor: tx },
      );

      expect(days[0]?.occurrence.areaId).toBe(fixture.yard);
    });
  });
});
