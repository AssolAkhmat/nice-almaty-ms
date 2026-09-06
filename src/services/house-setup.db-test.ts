import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { assignBedToResidency, houseLayout } from './beds';
import {
  archiveHouseArea,
  archiveHouseBed,
  createHouseArea,
  createHouseBed,
  readHouseSetup,
  updateHouseArea,
  updateHouseBed,
} from './house-setup';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Настройка дома: зоны, комнаты, места и цены по умолчанию
 * (docs/04-MODULES/02-places-and-payments.md, «Настройка дома»).
 *
 * Проверяется не форма экрана, а правила, которые нельзя нарушить данными:
 * место живёт только в жилой комнате, занятое место не архивируется,
 * а цена по умолчанию не переписывает цену уже назначенного места.
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

  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7707${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseA?.id ?? '',
    })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7708${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [residentUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: residentUser?.id ?? '',
      houseId: houseA?.id ?? '',
      status: 'active',
      moveInDate: '2026-09-01',
    })
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
    residencyId: residency?.id ?? '',
    admin: actor(context('admin', adminUser?.id ?? '', houseA?.id ?? null)),
    superadmin: actor(context('superadmin', superUser?.id ?? '', null)),
    resident: actor(context('resident', residentUser?.id ?? '', null)),
  };
}

describe('зоны дома', () => {
  it('админ заводит жилую комнату и общую зону', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9101');

      const room = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 3', type: 'living' },
        { executor: tx },
      );
      await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Кухня', type: 'common' },
        { executor: tx },
      );

      const setup = await readHouseSetup(fixture.admin, fixture.houseA, { executor: tx });

      expect(room.type).toBe('living');
      expect(setup.areas.map((area) => area.area.name)).toEqual(['Комната 3', 'Кухня']);
    });
  });

  it('порядок задаётся полем сортировки, а не порядком заведения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9102');

      await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Вторая', type: 'living', sortOrder: 2 },
        { executor: tx },
      );
      await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Первая', type: 'living', sortOrder: 1 },
        { executor: tx },
      );

      const setup = await readHouseSetup(fixture.admin, fixture.houseA, { executor: tx });

      expect(setup.areas.map((area) => area.area.name)).toEqual(['Первая', 'Вторая']);
    });
  });

  it('пустое название не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9103');

      await expect(
        createHouseArea(
          fixture.admin,
          fixture.houseA,
          { name: '   ', type: 'living' },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('чужой дом неотличим от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9104');

      await expect(
        createHouseArea(
          fixture.admin,
          fixture.houseB,
          { name: 'Комната', type: 'living' },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('жилец дом не настраивает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9105');

      await expect(
        createHouseArea(
          fixture.resident,
          fixture.houseA,
          { name: 'Комната', type: 'living' },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('переименование пишется в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9106');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 1', type: 'living' },
        { executor: tx },
      );

      const renamed = await updateHouseArea(
        fixture.admin,
        area.id,
        { name: 'Комната 1А' },
        { executor: tx },
      );

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, area.id));

      expect(renamed.name).toBe('Комната 1А');
      expect(entries.some((entry) => entry.action === 'area.updated')).toBe(true);
    });
  });

  it('архивированная зона исчезает из настройки и из схемы дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9107');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Кладовая', type: 'common' },
        { executor: tx },
      );

      await archiveHouseArea(fixture.admin, area.id, { executor: tx });

      const setup = await readHouseSetup(fixture.admin, fixture.houseA, { executor: tx });
      const layout = await houseLayout(fixture.admin, fixture.houseA, { executor: tx });

      expect(setup.areas).toHaveLength(0);
      expect(layout).toHaveLength(0);
    });
  });

  it('зону с местами архивировать нельзя: сначала места', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9108');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 2', type: 'living' },
        { executor: tx },
      );
      await createHouseBed(
        fixture.admin,
        area.id,
        { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000 },
        { executor: tx },
      );

      await expect(
        archiveHouseArea(fixture.admin, area.id, { executor: tx }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

describe('места и цены по умолчанию', () => {
  it('место заводится в жилой комнате с ценой по умолчанию', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9110');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 3', type: 'living' },
        { executor: tx },
      );

      const upper = await createHouseBed(
        fixture.admin,
        area.id,
        { label: '1 верх', number: 1, tier: 'upper', defaultPrice: 65_000 },
        { executor: tx },
      );
      const lower = await createHouseBed(
        fixture.admin,
        area.id,
        { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000 },
        { executor: tx },
      );

      // Пример из модуля 2: комната №3 — верхнее 65 000, нижнее 70 000.
      expect(upper.defaultPrice).toBe(65_000);
      expect(lower.defaultPrice).toBe(70_000);
    });
  });

  it('в общей зоне спать негде: место не заводится', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9111');

      const kitchen = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Кухня', type: 'common' },
        { executor: tx },
      );

      await expect(
        createHouseBed(
          fixture.admin,
          kitchen.id,
          { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000 },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('номер и ярус в комнате не повторяются', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9112');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 4', type: 'living' },
        { executor: tx },
      );
      await createHouseBed(
        fixture.admin,
        area.id,
        { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000 },
        { executor: tx },
      );

      await expect(
        createHouseBed(
          fixture.admin,
          area.id,
          { label: 'ещё одно', number: 1, tier: 'lower', defaultPrice: 70_000 },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('цена — целое неотрицательное число тенге', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9113');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 5', type: 'living' },
        { executor: tx },
      );

      await expect(
        createHouseBed(
          fixture.admin,
          area.id,
          { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000.5 },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        createHouseBed(
          fixture.admin,
          area.id,
          { label: '2 низ', number: 2, tier: 'lower', defaultPrice: -1 },
          { executor: tx },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('новая цена по умолчанию не трогает цену уже назначенного места', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9114');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 6', type: 'living' },
        { executor: tx },
      );
      const bed = await createHouseBed(
        fixture.admin,
        area.id,
        { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000 },
        { executor: tx },
      );

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: bed.id },
        { executor: tx, today: TODAY },
      );

      await updateHouseBed(fixture.admin, bed.id, { defaultPrice: 90_000 }, { executor: tx });

      const layout = await houseLayout(fixture.admin, fixture.houseA, { executor: tx });
      const slot = layout[0]?.beds[0];

      // Цена жильца индивидуальна: она живёт в назначении, а не в месте.
      expect(slot?.defaultPrice).toBe(90_000);
      expect(slot?.occupiedBy?.price).toBe(70_000);
    });
  });

  it('занятое место архивировать нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9115');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 7', type: 'living' },
        { executor: tx },
      );
      const bed = await createHouseBed(
        fixture.admin,
        area.id,
        { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000 },
        { executor: tx },
      );

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: bed.id },
        { executor: tx, today: TODAY },
      );

      await expect(archiveHouseBed(fixture.admin, bed.id, { executor: tx })).rejects.toBeInstanceOf(
        ConflictError,
      );
    });
  });

  it('свободное место архивируется и исчезает из схемы дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9116');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 8', type: 'living' },
        { executor: tx },
      );
      const bed = await createHouseBed(
        fixture.admin,
        area.id,
        { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000 },
        { executor: tx },
      );

      await archiveHouseBed(fixture.admin, bed.id, { executor: tx });

      const layout = await houseLayout(fixture.admin, fixture.houseA, { executor: tx });

      expect(layout[0]?.beds).toHaveLength(0);
    });
  });

  it('место чужого дома не настраивается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9117');

      const area = await createHouseArea(
        fixture.superadmin,
        fixture.houseB,
        { name: 'Комната B', type: 'living' },
        { executor: tx },
      );
      const bed = await createHouseBed(
        fixture.superadmin,
        area.id,
        { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000 },
        { executor: tx },
      );

      await expect(
        updateHouseBed(fixture.admin, bed.id, { defaultPrice: 1 }, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('сводка настройки дома', () => {
  it('показывает депозит дома и занятость мест', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9120');

      const area = await createHouseArea(
        fixture.admin,
        fixture.houseA,
        { name: 'Комната 9', type: 'living' },
        { executor: tx },
      );
      const bed = await createHouseBed(
        fixture.admin,
        area.id,
        { label: '1 низ', number: 1, tier: 'lower', defaultPrice: 70_000 },
        { executor: tx },
      );

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyId, bedId: bed.id },
        { executor: tx, today: TODAY },
      );

      const setup = await readHouseSetup(fixture.admin, fixture.houseA, { executor: tx });

      expect(setup.depositDefault).toBe(45_000);
      expect(setup.areas[0]?.beds[0]?.occupied).toBe(true);
    });
  });
});
