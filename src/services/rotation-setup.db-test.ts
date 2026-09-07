import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

import {
  archiveChecklist,
  createGroup,
  readRotationSetup,
  resolveGroup,
  saveChecklist,
  setAreaEligibility,
  updateGroup,
} from './rotation-setup';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Чек-листы и группы допуска (docs/03-BUSINESS-RULES.md §6.1,
 * docs/04-MODULES/11-users-settings.md, «Настройки дома»).
 *
 * Проверяется не форма экрана, а правила: свой дом ведёт только его админ,
 * группа разрешается в настоящих жильцов, а не в идентификаторы из правила,
 * и каждая правка видна в журнале.
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

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `rset-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `rset-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `rset-b-${suffix}` })
    .returning();

  const houseAId = houseA?.id ?? '';
  const houseBId = houseB?.id ?? '';

  const [room1] = await tx
    .insert(schema.areas)
    .values({ houseId: houseAId, type: 'living', name: 'Комната 1', sortOrder: 1 })
    .returning();
  const [room2] = await tx
    .insert(schema.areas)
    .values({ houseId: houseAId, type: 'living', name: 'Комната 2', sortOrder: 2 })
    .returning();
  const [yard] = await tx
    .insert(schema.areas)
    .values({ houseId: houseAId, type: 'common', name: 'Двор', sortOrder: 3 })
    .returning();
  const [roomB] = await tx
    .insert(schema.areas)
    .values({ houseId: houseBId, type: 'living', name: 'Комната соседа' })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId: houseAId })
    .returning();
  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7708${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  /** Жилец с полом и местом в комнате: и то, и другое нужно группам допуска. */
  async function resident(
    tag: string,
    sex: 'male' | 'female',
    areaId: string,
    number: number,
  ): Promise<string> {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7709${suffix}${tag}`, passwordHash: 'x', role: 'resident' })
      .returning();
    const userId = user?.id ?? '';

    await tx.insert(schema.residentProfiles).values({ userId, firstName: `Ж${tag}`, sex });

    const [residency] = await tx
      .insert(schema.residencies)
      .values({ orgId, userId, houseId: houseAId, status: 'active', moveInDate: '2026-09-01' })
      .returning();

    const [bed] = await tx
      .insert(schema.beds)
      .values({ houseId: houseAId, areaId, label: `M${tag}`, tier: 'lower', number })
      .returning();

    await tx.insert(schema.bedAssignments).values({
      residencyId: residency?.id ?? '',
      bedId: bed?.id ?? '',
      price: 100_000,
      period: '[2026-09-01,)',
    });

    return userId;
  }

  const azamat = await resident('1', 'male', room1?.id ?? '', 1);
  const daniyar = await resident('2', 'male', room1?.id ?? '', 2);
  const aliya = await resident('3', 'female', room2?.id ?? '', 3);

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
    room1: room1?.id ?? '',
    room2: room2?.id ?? '',
    yard: yard?.id ?? '',
    roomB: roomB?.id ?? '',
    azamat,
    daniyar,
    aliya,
    admin: actor(context('admin', adminUser?.id ?? '', houseAId)),
    adminB: actor(context('admin', adminUser?.id ?? '', houseBId)),
    superadmin: actor(context('superadmin', superUser?.id ?? '', null)),
    resident: actor(context('resident', azamat, null)),
  };
}

describe('чек-листы зон', () => {
  it('админ заводит чек-лист, и он виден в настройке дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9301');

      await saveChecklist(
        fixture.admin,
        {
          areaId: fixture.yard,
          type: 'regular',
          title: 'Двор',
          items: ['подмести', 'вынести мусор'],
          peopleNeeded: 2,
        },
        { executor: tx },
      );

      const setup = await readRotationSetup(fixture.admin, fixture.houseA, { executor: tx });
      const yard = setup.areas.find((area) => area.area.id === fixture.yard);

      expect(yard?.checklists).toHaveLength(1);
      expect(yard?.checklists[0]?.peopleNeeded).toBe(2);
    });
  });

  it('повторное сохранение того же вида правит чек-лист, а не заводит второй', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9302');

      await saveChecklist(
        fixture.admin,
        { areaId: fixture.yard, type: 'regular', title: 'Двор', peopleNeeded: 1 },
        { executor: tx },
      );
      await saveChecklist(
        fixture.admin,
        { areaId: fixture.yard, type: 'regular', title: 'Двор и урны', peopleNeeded: 2 },
        { executor: tx },
      );

      const setup = await readRotationSetup(fixture.admin, fixture.houseA, { executor: tx });
      const yard = setup.areas.find((area) => area.area.id === fixture.yard);

      expect(yard?.checklists).toHaveLength(1);
      expect(yard?.checklists[0]?.title).toBe('Двор и урны');
      expect(yard?.checklists[0]?.peopleNeeded).toBe(2);
    });
  });

  it('на зону помещаются оба вида: обычная и генеральная', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9303');

      await saveChecklist(
        fixture.admin,
        { areaId: fixture.yard, type: 'regular', title: 'Двор' },
        { executor: tx },
      );
      await saveChecklist(
        fixture.admin,
        { areaId: fixture.yard, type: 'general', title: 'Двор, генеральная' },
        { executor: tx },
      );

      const setup = await readRotationSetup(fixture.admin, fixture.houseA, { executor: tx });
      const yard = setup.areas.find((area) => area.area.id === fixture.yard);

      expect(yard?.checklists.map((item) => item.type)).toEqual(['regular', 'general']);
    });
  });

  it('пустое название и нулевое число людей не принимаются', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9304');

      await expect(
        saveChecklist(
          fixture.admin,
          { areaId: fixture.yard, type: 'regular', title: '   ' },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        saveChecklist(
          fixture.admin,
          { areaId: fixture.yard, type: 'regular', title: 'Двор', peopleNeeded: 0 },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('жилец не ведёт настройку дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9305');

      await expect(
        saveChecklist(
          fixture.resident,
          { areaId: fixture.yard, type: 'regular', title: 'Двор' },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        readRotationSetup(fixture.resident, fixture.houseA, { executor: tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('админ соседнего дома до чужой зоны не дотягивается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9306');

      await expect(
        saveChecklist(
          fixture.adminB,
          { areaId: fixture.yard, type: 'regular', title: 'Двор' },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('правка чек-листа попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9307');

      const checklist = await saveChecklist(
        fixture.admin,
        { areaId: fixture.yard, type: 'regular', title: 'Двор' },
        { executor: tx },
      );

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.entityType, 'area_checklist'),
            eq(schema.auditLog.entityId, checklist.id),
          ),
        );

      expect(entries.map((entry) => entry.action)).toContain('checklist.saved');
    });
  });

  it('архивированный чек-лист из настройки уходит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9308');

      const checklist = await saveChecklist(
        fixture.admin,
        { areaId: fixture.yard, type: 'regular', title: 'Двор' },
        { executor: tx },
      );
      await archiveChecklist(fixture.admin, checklist.id, { executor: tx });

      const setup = await readRotationSetup(fixture.admin, fixture.houseA, { executor: tx });
      const yard = setup.areas.find((area) => area.area.id === fixture.yard);

      expect(yard?.checklists).toHaveLength(0);
    });
  });
});

describe('группы допуска', () => {
  it('«парни, кроме Азамата» разрешается в живых жильцов дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9310');

      const group = await createGroup(
        fixture.admin,
        {
          houseId: fixture.houseA,
          name: 'Двор: парни, кроме Азамата',
          rule: { base: 'male', excludeUserIds: [fixture.azamat] },
        },
        { executor: tx },
      );

      expect(await resolveGroup(fixture.admin, group.id, { executor: tx })).toEqual([
        fixture.daniyar,
      ]);
    });
  });

  it('«жильцы комнаты» берут комнату по назначенным местам', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9311');

      const group = await createGroup(
        fixture.admin,
        {
          houseId: fixture.houseA,
          name: 'Комната 1',
          rule: { base: 'room', areaId: fixture.room1 },
        },
        { executor: tx },
      );

      expect(await resolveGroup(fixture.admin, group.id, { executor: tx })).toEqual([
        fixture.azamat,
        fixture.daniyar,
      ]);
    });
  });

  it('незнакомая основа не сохраняется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9312');

      await expect(
        createGroup(
          fixture.admin,
          { houseId: fixture.houseA, name: 'Странная', rule: { base: 'everyone' } },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('правило группы правится, и список пересобирается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9313');

      const group = await createGroup(
        fixture.admin,
        { houseId: fixture.houseA, name: 'Все', rule: { base: 'all' } },
        { executor: tx },
      );
      await updateGroup(fixture.admin, group.id, { rule: { base: 'female' } }, { executor: tx });

      expect(await resolveGroup(fixture.admin, group.id, { executor: tx })).toEqual([
        fixture.aliya,
      ]);
    });
  });

  it('жилец группы не заводит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9314');

      await expect(
        createGroup(
          fixture.resident,
          { houseId: fixture.houseA, name: 'Своя', rule: { base: 'all' } },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('допуск к зоне', () => {
  it('группы привязываются к зоне по виду уборки и заменяются целиком', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9320');

      const boys = await createGroup(
        fixture.admin,
        { houseId: fixture.houseA, name: 'Парни', rule: { base: 'male' } },
        { executor: tx },
      );
      const girls = await createGroup(
        fixture.admin,
        { houseId: fixture.houseA, name: 'Девушки', rule: { base: 'female' } },
        { executor: tx },
      );

      await setAreaEligibility(
        fixture.admin,
        { areaId: fixture.yard, checklistType: 'regular', groupIds: [boys.id, girls.id] },
        { executor: tx },
      );
      await setAreaEligibility(
        fixture.admin,
        { areaId: fixture.yard, checklistType: 'regular', groupIds: [girls.id] },
        { executor: tx },
      );

      const setup = await readRotationSetup(fixture.admin, fixture.houseA, { executor: tx });
      const yard = setup.areas.find((area) => area.area.id === fixture.yard);

      expect(yard?.eligibility.regular).toEqual([girls.id]);
      expect(yard?.eligibility.general).toEqual([]);
    });
  });

  it('группа чужого дома к своей зоне не привязывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9321');

      const [strangerGroup] = await tx
        .insert(schema.eligibilityGroups)
        .values({
          orgId: fixture.orgId,
          houseId: fixture.houseB,
          name: 'Чужая',
          rule: { base: 'all' },
        })
        .returning();

      await expect(
        setAreaEligibility(
          fixture.admin,
          {
            areaId: fixture.yard,
            checklistType: 'regular',
            groupIds: [strangerGroup?.id ?? ''],
          },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
