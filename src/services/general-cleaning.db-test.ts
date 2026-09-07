import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import {
  generateGeneralCleaning,
  readGeneralCleaningSettings,
  setCancelRegularOnGeneral,
} from './general-cleaning';
import { readCalendar } from './rotation-calendar';
import { saveRow } from './rotation-rows';
import { generateSchedule } from './rotation-schedule';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Генеральная уборка (docs/03-BUSINESS-RULES.md §6.5).
 *
 * Последнее воскресенье месяца, участвуют все жильцы дома вместе с админом,
 * расклад детерминирован по сиду «дом плюс дата».
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

/** Последнее воскресенье сентября 2026 года. */
const GENERAL_DAY = parseBusinessDate('2026-09-27');
const SEPTEMBER = parseBusinessDate('2026-09-06');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `gen-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `gen-a-${suffix}` })
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
  const [kitchen] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'common', name: 'Кухня' })
    .returning();

  async function checklist(
    areaId: string,
    type: 'regular' | 'general',
    peopleNeeded = 1,
  ): Promise<string> {
    const [row] = await tx
      .insert(schema.areaChecklists)
      .values({ areaId, type, title: type === 'general' ? 'Генеральная' : 'Уборка', peopleNeeded })
      .returning();

    return row?.id ?? '';
  }

  const yardGeneral = await checklist(yard?.id ?? '', 'general', 2);
  const kitchenGeneral = await checklist(kitchen?.id ?? '', 'general');
  const kitchenRegular = await checklist(kitchen?.id ?? '', 'regular');

  const beds: string[] = [];
  for (let number = 1; number <= 3; number += 1) {
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
    beds.push(bed?.id ?? '');
  }

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  async function resident(tag: string, bedId: string, sex: 'male' | 'female'): Promise<string> {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7709${suffix}${tag}`, passwordHash: 'x', role: 'resident' })
      .returning();
    const userId = user?.id ?? '';

    await tx.insert(schema.residentProfiles).values({ userId, firstName: `Ж${tag}`, sex });

    const [residency] = await tx
      .insert(schema.residencies)
      .values({ orgId, userId, houseId, status: 'active', moveInDate: '2026-09-01' })
      .returning();

    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId,
      price: 100_000,
      period: '[2026-09-01,)',
    });

    return userId;
  }

  const first = await resident('1', beds[0] ?? '', 'male');
  const second = await resident('2', beds[1] ?? '', 'male');
  const third = await resident('3', beds[2] ?? '', 'female');

  const context = (
    role: AccessContext['role'],
    userId: string,
    forHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: forHouse });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseId,
    room: room?.id ?? '',
    yard: yard?.id ?? '',
    kitchen: kitchen?.id ?? '',
    yardGeneral,
    kitchenGeneral,
    kitchenRegular,
    beds,
    adminUserId: adminUser?.id ?? '',
    first,
    second,
    third,
    admin: actor(context('admin', adminUser?.id ?? '', houseId)),
    resident: actor(context('resident', first, null)),
  };
}

describe('генеральная уборка', () => {
  it('раскладывает зоны с генеральными чек-листами по жильцам дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9701');

      const result = await generateGeneralCleaning(fixture.admin, fixture.houseId, GENERAL_DAY, {
        executor: tx,
      });

      expect(result.created).toBe(2);

      const day = await readCalendar(
        fixture.admin,
        { from: GENERAL_DAY, to: GENERAL_DAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(day.occurrences).toHaveLength(2);
      expect(day.occurrences.every((item) => item.occurrence.type === 'general')).toBe(true);

      const assignments = day.occurrences.flatMap((item) => item.assignments);
      // Двор требует двоих, кухня одного: три назначения на три места.
      expect(assignments).toHaveLength(3);
    });
  });

  it('в уборке участвует и админ дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9702');

      await generateGeneralCleaning(fixture.admin, fixture.houseId, GENERAL_DAY, { executor: tx });

      const day = await readCalendar(
        fixture.admin,
        { from: GENERAL_DAY, to: GENERAL_DAY },
        { executor: tx, houseId: fixture.houseId },
      );
      const people = day.occurrences.flatMap((item) =>
        item.assignments.map((assignment) => assignment.userId),
      );

      expect(people.filter((userId) => userId !== null)).toHaveLength(3);
      expect(new Set(people).size).toBe(3);

      // Мест больше, чем жильцов: четвёртое достаётся админу дома — §6.5
      // называет его участником наравне со всеми.
      await tx
        .update(schema.areaChecklists)
        .set({ peopleNeeded: 3 })
        .where(eq(schema.areaChecklists.id, fixture.yardGeneral));
      await tx.delete(schema.rotationAssignments);
      await tx.delete(schema.rotationOccurrences);

      await generateGeneralCleaning(fixture.admin, fixture.houseId, GENERAL_DAY, { executor: tx });

      const wider = await readCalendar(
        fixture.admin,
        { from: GENERAL_DAY, to: GENERAL_DAY },
        { executor: tx, houseId: fixture.houseId },
      );
      const everyone = wider.occurrences.flatMap((item) =>
        item.assignments.map((assignment) => assignment.userId),
      );

      expect(everyone).toContain(fixture.adminUserId);
    });
  });

  it('расклад повторяется: тот же дом и та же дата дают то же самое', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9703');

      await generateGeneralCleaning(fixture.admin, fixture.houseId, GENERAL_DAY, { executor: tx });

      const first = await readCalendar(
        fixture.admin,
        { from: GENERAL_DAY, to: GENERAL_DAY },
        { executor: tx, houseId: fixture.houseId },
      );

      // Повторный вызов ничего не создаёт: занятия этого дня уже есть.
      const again = await generateGeneralCleaning(fixture.admin, fixture.houseId, GENERAL_DAY, {
        executor: tx,
      });

      expect(again.created).toBe(0);

      const second = await readCalendar(
        fixture.admin,
        { from: GENERAL_DAY, to: GENERAL_DAY },
        { executor: tx, houseId: fixture.houseId },
      );

      expect(second.occurrences.map((item) => item.occurrence.id).sort()).toEqual(
        first.occurrences.map((item) => item.occurrence.id).sort(),
      );
    });
  });

  it('группа допуска сужает круг: двор достаётся только парням', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9704');

      const [group] = await tx
        .insert(schema.eligibilityGroups)
        .values({
          orgId: fixture.orgId,
          houseId: fixture.houseId,
          name: 'Парни',
          rule: { base: 'male' },
        })
        .returning();

      await tx.insert(schema.areaEligibility).values({
        areaId: fixture.yard,
        checklistType: 'general',
        groupId: group?.id ?? '',
      });

      await generateGeneralCleaning(fixture.admin, fixture.houseId, GENERAL_DAY, { executor: tx });

      const day = await readCalendar(
        fixture.admin,
        { from: GENERAL_DAY, to: GENERAL_DAY },
        { executor: tx, houseId: fixture.houseId },
      );
      const yard = day.occurrences.find((item) => item.occurrence.areaId === fixture.yard);
      const assigned = yard?.assignments.map((item) => item.userId) ?? [];

      expect(assigned).toHaveLength(2);
      expect(assigned).not.toContain(fixture.third);
    });
  });

  it('обычная ротация этого воскресенья отменяется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9705');

      await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseId,
          name: 'Воскресный ряд',
          type: 'common',
          weekday: 0,
          startDate: SEPTEMBER,
          slots: fixture.beds.map((bedId) => ({ bedId })),
          zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenRegular }],
        },
        { executor: tx },
      );
      await generateSchedule(fixture.admin, fixture.houseId, GENERAL_DAY, {
        executor: tx,
        today: SEPTEMBER,
      });

      await generateGeneralCleaning(fixture.admin, fixture.houseId, GENERAL_DAY, { executor: tx });

      const day = await readCalendar(
        fixture.admin,
        { from: GENERAL_DAY, to: GENERAL_DAY },
        { executor: tx, houseId: fixture.houseId },
      );

      const regular = day.occurrences.filter((item) => item.occurrence.type === 'regular');
      expect(regular).toHaveLength(1);
      expect(regular[0]?.occurrence.status).toBe('cancelled');
    });
  });

  it('переключатель оставляет обычную ротацию на месте', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9706');

      await setCancelRegularOnGeneral(fixture.admin, fixture.houseId, false, { executor: tx });

      await saveRow(
        fixture.admin,
        {
          houseId: fixture.houseId,
          name: 'Воскресный ряд',
          type: 'common',
          weekday: 0,
          startDate: SEPTEMBER,
          slots: fixture.beds.map((bedId) => ({ bedId })),
          zones: [{ areaId: fixture.kitchen, checklistId: fixture.kitchenRegular }],
        },
        { executor: tx },
      );
      await generateSchedule(fixture.admin, fixture.houseId, GENERAL_DAY, {
        executor: tx,
        today: SEPTEMBER,
      });

      await generateGeneralCleaning(fixture.admin, fixture.houseId, GENERAL_DAY, { executor: tx });

      const day = await readCalendar(
        fixture.admin,
        { from: GENERAL_DAY, to: GENERAL_DAY },
        { executor: tx, houseId: fixture.houseId },
      );
      const regular = day.occurrences.filter((item) => item.occurrence.type === 'regular');

      expect(regular[0]?.occurrence.status).toBe('scheduled');
      expect(
        await readGeneralCleaningSettings(fixture.admin, fixture.houseId, { executor: tx }),
      ).toEqual({ cancelRegular: false });
    });
  });

  it('по умолчанию обычная ротация отменяется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9707');

      expect(
        await readGeneralCleaningSettings(fixture.admin, fixture.houseId, { executor: tx }),
      ).toEqual({ cancelRegular: true });
    });
  });

  it('жилец генеральную уборку не назначает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9708');

      await expect(
        generateGeneralCleaning(fixture.resident, fixture.houseId, GENERAL_DAY, { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('дом без генеральных чек-листов уборку не получает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9709');

      // Оставляем дому только обычные чек-листы: генеральной уборке нечего делать.
      await tx.delete(schema.areaChecklists).where(eq(schema.areaChecklists.type, 'general'));

      const result = await generateGeneralCleaning(fixture.admin, fixture.houseId, GENERAL_DAY, {
        executor: tx,
      });

      expect(result.created).toBe(0);
    });
  });
});
