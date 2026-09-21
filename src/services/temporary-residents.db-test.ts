import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { seedRow } from '@/db/testing/rotation-row';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { assignBedToResidency } from './beds';
import { closeRotationDay } from './rotation-close-day';
import { generateSchedule } from './rotation-schedule';
import { readRotationStats } from './rotation-stats';
import { addTemporary, listTemporary, removeTemporary } from './temporary-residents';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Временные жильцы для ротаций (T11.3, указание владельца 21 сентября 2026).
 *
 * Проверяется то, ради чего их завели: временный встаёт в ряд по месту,
 * попадает в фильтры допуска по полу — и не портит статистику, когда день
 * закрылся без подтверждения.
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

/** Понедельник: ряды заводятся на день недели, и день должен совпадать. */
const MONDAY = parseBusinessDate('2026-09-07');
const TUESDAY = parseBusinessDate('2026-09-08');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `temp-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `temp-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'living', name: 'Комната 1' })
    .returning();
  const [kitchen] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'common', name: 'Кухня' })
    .returning();

  const [checklist] = await tx
    .insert(schema.areaChecklists)
    .values({ areaId: kitchen?.id ?? '', type: 'regular', title: 'Уборка кухни', peopleNeeded: 1 })
    .returning();

  const [bed] = await tx
    .insert(schema.beds)
    .values({ houseId, areaId: room?.id ?? '', label: 'М1', tier: 'lower', number: 1 })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();
  const [residentUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const actor = (
    role: AccessContext['role'],
    userId: string,
    ofHouse: string | null,
  ): UserActor => ({
    context: { orgId, userId, role, houseId: ofHouse },
    requestId: `req-${suffix}`,
  });

  return {
    orgId,
    houseId,
    bedId: bed?.id ?? '',
    roomId: room?.id ?? '',
    kitchenId: kitchen?.id ?? '',
    checklistId: checklist?.id ?? '',
    admin: actor('admin', adminUser?.id ?? '', houseId),
    resident: actor('resident', residentUser?.id ?? '', null),
    network: actor('superadmin', superUser?.id ?? '', null),
  };
}

/** Ряд из одного места и одной зоны: этого хватает, чтобы увидеть исполнителя. */
async function rowOfOneBed(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
): Promise<void> {
  await seedRow(
    fixture.admin,
    {
      houseId: fixture.houseId,
      name: 'Кухня по понедельникам',
      type: 'common',
      weekday: 1,
      startDate: MONDAY,
      bedIds: [fixture.bedId],
      zones: [{ areaId: fixture.kitchenId, checklistId: fixture.checklistId }],
    },
    { executor: tx },
  );
}

async function addAsel(
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seed>>,
  sex: 'male' | 'female' = 'female',
) {
  return addTemporary(
    fixture.admin,
    {
      houseId: fixture.houseId,
      bedId: fixture.bedId,
      name: 'Асель',
      sex,
      period: { from: MONDAY, to: null },
    },
    { executor: tx },
  );
}

describe('временный жилец', () => {
  it('заводится админом дома и виден в перечне со своим местом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8001');
      const created = await addAsel(tx, fixture);

      expect(created.name).toBe('Асель');
      expect(created.sex).toBe('female');

      const [listed] = await listTemporary(
        fixture.admin,
        { houseId: fixture.houseId },
        { executor: tx },
      );

      expect(listed?.id).toBe(created.id);
      expect(listed?.bedLabel).toBe('М1');
      expect(listed?.areaName).toBe('Комната 1');
    });
  });

  it('жилец завести его не может', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8002');

      await expect(
        addTemporary(
          fixture.resident,
          {
            houseId: fixture.houseId,
            bedId: fixture.bedId,
            name: 'Кто-то',
            sex: 'male',
            period: { from: MONDAY, to: null },
          },
          { executor: tx },
        ),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  it('на занятое место второго не завести: отказ базы становится понятной ошибкой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8003');
      await addAsel(tx, fixture);

      await expect(
        addTemporary(
          fixture.admin,
          {
            houseId: fixture.houseId,
            bedId: fixture.bedId,
            name: 'Дана',
            sex: 'female',
            period: { from: TUESDAY, to: null },
          },
          { executor: tx },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('снятие с места закрывает период сегодняшним днём, а не стирает историю', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8004');
      const created = await addAsel(tx, fixture);

      await removeTemporary(fixture.admin, created.id, { executor: tx, today: TUESDAY });

      const [row] = await tx
        .select()
        .from(schema.temporaryResidents)
        .where(eq(schema.temporaryResidents.id, created.id));

      expect(row?.period).toBe(`[${MONDAY},${TUESDAY})`);
    });
  });
});

describe('временный жилец в ротациях', () => {
  it('генератор ставит его в ряд по месту', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8010');
      const temporary = await addAsel(tx, fixture);
      await rowOfOneBed(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const assignments = await tx.select().from(schema.rotationAssignments);
      const [assignment] = assignments;

      expect(assignments).toHaveLength(1);
      expect(assignment?.temporaryResidentId).toBe(temporary.id);
      expect(assignment?.userId).toBeNull();
      expect(assignment?.state).toBe('assigned');
      expect(assignment?.emptyReason).toBeNull();
    });
  });

  /*
   * Пол — обязательное поле именно ради этого: фильтр «девушки» пропускает
   * временную жилицу сам, без единой правки в группах допуска.
   */
  it('проходит фильтр допуска по полу наравне с настоящими жильцами', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8011');
      const temporary = await addAsel(tx, fixture, 'female');
      await rowOfOneBed(tx, fixture);

      const [group] = await tx
        .insert(schema.eligibilityGroups)
        .values({
          orgId: fixture.orgId,
          houseId: fixture.houseId,
          name: 'Девушки',
          rule: { base: 'female' },
        })
        .returning();

      await tx.insert(schema.areaEligibility).values({
        areaId: fixture.kitchenId,
        checklistType: 'regular',
        groupId: group?.id ?? '',
      });

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const [assignment] = await tx.select().from(schema.rotationAssignments);

      expect(assignment?.temporaryResidentId).toBe(temporary.id);
      expect(assignment?.emptyReason).toBeNull();
    });
  });

  it('в группу другого пола не попадает, и дырка сохраняет его имя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8012');
      const temporary = await addAsel(tx, fixture, 'male');
      await rowOfOneBed(tx, fixture);

      const [group] = await tx
        .insert(schema.eligibilityGroups)
        .values({
          orgId: fixture.orgId,
          houseId: fixture.houseId,
          name: 'Девушки',
          rule: { base: 'female' },
        })
        .returning();

      await tx.insert(schema.areaEligibility).values({
        areaId: fixture.kitchenId,
        checklistType: 'regular',
        groupId: group?.id ?? '',
      });

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const [assignment] = await tx.select().from(schema.rotationAssignments);

      expect(assignment?.emptyReason).toBe('not_eligible');
      expect(assignment?.queuedTemporaryResidentId).toBe(temporary.id);
      expect(assignment?.queuedUserId).toBeNull();
    });
  });
});

/**
 * Статистику временные не портят (D23): день, закрытый без подтверждения,
 * даёт статус «не подтверждена», а не «пропущено».
 */
describe('закрытие дня с временным жильцом', () => {
  async function scheduledDay(tx: Transaction, suffix: string) {
    const fixture = await seed(tx, suffix);
    const temporary = await addAsel(tx, fixture);
    await rowOfOneBed(tx, fixture);

    await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
      executor: tx,
      today: MONDAY,
    });

    // Закрытие дня идёт от имени суперадмина сети и закрывает вчерашний день.
    await closeRotationDay({ executor: tx, instant: new Date('2026-09-08T00:00:00Z') });

    return { fixture, temporary };
  }

  it('ротация временного не становится пропуском', async () => {
    await inRollback(async (tx) => {
      await scheduledDay(tx, '8020');

      const [assignment] = await tx.select().from(schema.rotationAssignments);

      expect(assignment?.state).toBe('unconfirmed');
      expect(assignment?.score).toBeNull();
    });
  });

  it('ни долга, ни события рейтинга: спрашивать не с кого', async () => {
    await inRollback(async (tx) => {
      await scheduledDay(tx, '8021');

      expect(await tx.select().from(schema.rotationDebts)).toHaveLength(0);
      expect(await tx.select().from(schema.ratingEvents)).toHaveLength(0);
    });
  });

  it('занятие остаётся в плане: подтвердить его админ может и завтра', async () => {
    await inRollback(async (tx) => {
      await scheduledDay(tx, '8022');

      const [occurrence] = await tx.select().from(schema.rotationOccurrences);

      expect(occurrence?.status).toBe('scheduled');
    });
  });

  it('в статистике дома и зон такой день не считается пропуском', async () => {
    await inRollback(async (tx) => {
      const { fixture } = await scheduledDay(tx, '8023');

      const stats = await readRotationStats(
        fixture.admin,
        fixture.houseId,
        { from: MONDAY, to: TUESDAY },
        { executor: tx },
      );

      expect(stats.total).toBe(0);
      expect(stats.byArea.every((area) => area.missed === 0)).toBe(true);
      expect(stats.byPerson).toEqual([]);
    });
  });
});

/**
 * Переход «временный → настоящий» (указание владельца, 21 сентября 2026):
 * заселение снимает временного с места, но прошлое остаётся за ним.
 */
describe('переход к настоящему жильцу', () => {
  it('заселение обрезает период временного, а прошлые ротации остаются за ним', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8030');
      const temporary = await addAsel(tx, fixture);
      await rowOfOneBed(tx, fixture);

      await generateSchedule(fixture.admin, fixture.houseId, MONDAY, {
        executor: tx,
        today: MONDAY,
      });

      const [user] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77098030001',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();
      const [residency] = await tx
        .insert(schema.residencies)
        .values({
          orgId: fixture.orgId,
          userId: user?.id ?? '',
          houseId: fixture.houseId,
          status: 'active',
          moveInDate: TUESDAY,
        })
        .returning();

      await assignBedToResidency(
        fixture.admin,
        { residencyId: residency?.id ?? '', bedId: fixture.bedId, from: TUESDAY },
        { executor: tx, today: TUESDAY },
      );

      const [released] = await tx
        .select()
        .from(schema.temporaryResidents)
        .where(eq(schema.temporaryResidents.id, temporary.id));

      // Период закрыт днём заселения: место свободно ровно с этого дня.
      expect(released?.period).toBe(`[${MONDAY},${TUESDAY})`);

      // Занятие понедельника по-прежнему за временным: история не переписана.
      const [assignment] = await tx.select().from(schema.rotationAssignments);
      expect(assignment?.temporaryResidentId).toBe(temporary.id);
    });
  });

  it('заселение с той же даты, что и приход временного, убирает его целиком', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8031');
      const temporary = await addAsel(tx, fixture);

      const [user] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.orgId,
          phone: '+77098031001',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();
      const [residency] = await tx
        .insert(schema.residencies)
        .values({
          orgId: fixture.orgId,
          userId: user?.id ?? '',
          houseId: fixture.houseId,
          status: 'active',
          moveInDate: MONDAY,
        })
        .returning();

      await assignBedToResidency(
        fixture.admin,
        { residencyId: residency?.id ?? '', bedId: fixture.bedId, from: MONDAY },
        { executor: tx, today: MONDAY },
      );

      const rows = await tx
        .select()
        .from(schema.temporaryResidents)
        .where(eq(schema.temporaryResidents.id, temporary.id));

      expect(rows).toHaveLength(0);
    });
  });
});
