import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import {
  consumeItem,
  listInventory,
  readItemHistory,
  receiveItem,
  setItemArea,
  transferItem,
} from './inventory';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Инвентарь (docs/04-MODULES/10-accounting-inventory.md, «Инвентарь»).
 *
 * Количество — следствие движений, а не отдельное поле, которое правят
 * руками. Админ ведёт свой дом: чужой для него не существует.
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

const TODAY = parseBusinessDate('2026-09-07');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `inv-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `inv-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `inv-b-${suffix}` })
    .returning();

  const houseAId = houseA?.id ?? '';
  const houseBId = houseB?.id ?? '';

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [adminA] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7707${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseAId,
    })
    .returning();
  const [dwellerUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const actor = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): UserActor => ({
    context: { orgId, userId, role, houseId },
    requestId: `req-${suffix}`,
  });

  return {
    orgId,
    houseA: houseAId,
    houseB: houseBId,
    network: actor('superadmin', superUser?.id ?? '', null),
    admin: actor('admin', adminA?.id ?? '', houseAId),
    dweller: actor('resident', dwellerUser?.id ?? '', null),
  };
}

describe('приход и расход', () => {
  it('приход заводит позицию и первое движение', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6801');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseA, name: 'Краска', unit: 'л', unitCost: 3_500, qty: '12.50' },
        { executor: tx, today: TODAY },
      );

      expect(item.qty).toBe('12.50');
      expect(item.status).toBe('in_use');

      const { movements } = await readItemHistory(fixture.admin, item.id, { executor: tx });
      expect(movements).toHaveLength(1);
      expect(movements[0]?.type).toBe('in');
      expect(movements[0]?.toHouseId).toBe(fixture.houseA);
    });
  });

  it('расход уменьшает количество, история остаётся', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6802');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseA, name: 'Краска', unit: 'л', unitCost: 3_500, qty: '12.50' },
        { executor: tx, today: TODAY },
      );

      const after = await consumeItem(
        fixture.admin,
        item.id,
        { qty: '2.50', type: 'out' },
        { executor: tx, today: TODAY },
      );

      expect(after.qty).toBe('10.00');

      const { movements } = await readItemHistory(fixture.admin, item.id, { executor: tx });
      expect(movements).toHaveLength(2);
    });
  });

  it('списать больше, чем есть, нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6803');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseA, name: 'Швабра', unit: 'шт', unitCost: 2_000, qty: '2' },
        { executor: tx, today: TODAY },
      );

      await expect(
        consumeItem(
          fixture.admin,
          item.id,
          { qty: '3', type: 'write_off' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('списанное подчистую перестаёт числиться в доме', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6804');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseA, name: 'Швабра', unit: 'шт', unitCost: 2_000, qty: '2' },
        { executor: tx, today: TODAY },
      );

      const after = await consumeItem(
        fixture.admin,
        item.id,
        { qty: '2', type: 'write_off' },
        { executor: tx, today: TODAY },
      );

      expect(after.status).toBe('written_off');
      expect(after.qty).toBe('0.00');
    });
  });

  it('нулевое и отрицательное количество не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6805');

      await expect(
        receiveItem(
          fixture.admin,
          { houseId: fixture.houseA, name: 'Краска', unit: 'л', unitCost: 100, qty: '0' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe('перемещение между домами', () => {
  it('суперадмин переносит позицию целиком', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6806');

      const item = await receiveItem(
        fixture.network,
        { houseId: fixture.houseA, name: 'Стремянка', unit: 'шт', unitCost: 25_000, qty: '1' },
        { executor: tx, today: TODAY },
      );

      const moved = await transferItem(fixture.network, item.id, fixture.houseB, {
        executor: tx,
        today: TODAY,
      });

      expect(moved.houseId).toBe(fixture.houseB);
      expect(moved.qty).toBe('1.00');

      const { movements } = await readItemHistory(fixture.network, item.id, { executor: tx });
      const transfer = movements.find((movement) => movement.type === 'transfer');
      expect(transfer?.fromHouseId).toBe(fixture.houseA);
      expect(transfer?.toHouseId).toBe(fixture.houseB);
    });
  });

  it('админ не перемещает в чужой дом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6807');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseA, name: 'Стремянка', unit: 'шт', unitCost: 25_000, qty: '1' },
        { executor: tx, today: TODAY },
      );

      /*
       * Чужой дом вне области видимости — «не найдено», а не «нет прав»:
       * иначе перебором домов админ узнавал бы состав сети (P1-1).
       */
      await expect(
        transferItem(fixture.admin, item.id, fixture.houseB, { executor: tx, today: TODAY }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('чужой дом', () => {
  it('позиция чужого дома для админа не существует', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6808');

      const foreign = await receiveItem(
        fixture.network,
        { houseId: fixture.houseB, name: 'Пылесос', unit: 'шт', unitCost: 60_000, qty: '1' },
        { executor: tx, today: TODAY },
      );

      await expect(
        readItemHistory(fixture.admin, foreign.id, { executor: tx }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const visible = await listInventory(fixture.admin, {}, { executor: tx });
      expect(visible.map((item) => item.id)).not.toContain(foreign.id);
    });
  });

  it('жилец инвентаря не ведёт вовсе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6809');

      await expect(
        receiveItem(
          fixture.dweller,
          { houseId: fixture.houseA, name: 'Краска', unit: 'л', unitCost: 100, qty: '1' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('журнал', () => {
  it('приход и перемещение попадают в аудит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6810');

      const item = await receiveItem(
        fixture.network,
        { houseId: fixture.houseA, name: 'Стремянка', unit: 'шт', unitCost: 25_000, qty: '1' },
        { executor: tx, today: TODAY },
      );
      await transferItem(fixture.network, item.id, fixture.houseB, { executor: tx, today: TODAY });

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, item.id));

      expect(entries.map((entry) => entry.action).sort()).toEqual([
        'inventory_item.created',
        'inventory_item.moved',
      ]);
    });
  });
});

/**
 * Зона дома у позиции (модуль 10, указание владельца 21 сентября 2026).
 *
 * Принадлежность зоны дому обеспечивает составной внешний ключ
 * `(area_id, house_id) → areas(id, house_id)`, а не проверка в сервисе.
 * Поэтому здесь два разных доказательства: сервис отвечает внятным отказом,
 * а база отвергает запись и в обход сервиса.
 */
describe('зона позиции', () => {
  async function withAreas(tx: Transaction, suffix: string) {
    const fixture = await seed(tx, suffix);

    const [kitchen] = await tx
      .insert(schema.areas)
      .values({ houseId: fixture.houseA, type: 'common', name: 'Кухня' })
      .returning();
    const [yardOfB] = await tx
      .insert(schema.areas)
      .values({ houseId: fixture.houseB, type: 'common', name: 'Двор дома B' })
      .returning();

    return { ...fixture, kitchen: kitchen?.id ?? '', yardOfB: yardOfB?.id ?? '' };
  }

  it('приход с зоной своего дома проходит, и зона видна в перечне', async () => {
    await inRollback(async (tx) => {
      const fixture = await withAreas(tx, '7101');

      const item = await receiveItem(
        fixture.admin,
        {
          houseId: fixture.houseA,
          areaId: fixture.kitchen,
          name: 'Чайник',
          unit: 'шт',
          unitCost: 12000,
          qty: '1',
        },
        { executor: tx, today: TODAY },
      );

      expect(item.areaId).toBe(fixture.kitchen);

      const [listed] = await listInventory(
        fixture.admin,
        { houseId: fixture.houseA },
        { executor: tx, today: TODAY },
      );

      expect(listed?.areaName).toBe('Кухня');
    });
  });

  it('зона чужого дома отклоняется сервисом внятной ошибкой', async () => {
    await inRollback(async (tx) => {
      const fixture = await withAreas(tx, '7102');

      await expect(
        receiveItem(
          fixture.network,
          {
            houseId: fixture.houseA,
            areaId: fixture.yardOfB,
            name: 'Чайник',
            unit: 'шт',
            unitCost: 1,
            qty: '1',
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  /*
   * Негативная фикстура к правилу доказанного запрета (CLAUDE.md §2):
   * если бы гарантия держалась только на сервисе, эта запись прошла бы.
   */
  it('зону чужого дома отвергает сама база, в обход сервиса', async () => {
    await inRollback(async (tx) => {
      const fixture = await withAreas(tx, '7103');

      const failure = await tx
        .insert(schema.inventoryItems)
        .values({
          orgId: fixture.orgId,
          houseId: fixture.houseA,
          areaId: fixture.yardOfB,
          name: 'Мимо сервиса',
          unit: 'шт',
        })
        .then(
          () => null,
          (reason: unknown) => reason,
        );

      // Имя ограничения лежит в причине: так видно, что сработал именно
      // составной ключ, а не какая-нибудь другая проверка по дороге.
      const cause = (failure as { cause?: { code?: string; constraint_name?: string } }).cause;

      expect(cause?.code).toBe('23503');
      expect(cause?.constraint_name).toBe('inventory_items_area_house_fk');
    });
  });

  it('перемещение в другой дом снимает зону', async () => {
    await inRollback(async (tx) => {
      const fixture = await withAreas(tx, '7104');

      const item = await receiveItem(
        fixture.network,
        {
          houseId: fixture.houseA,
          areaId: fixture.kitchen,
          name: 'Стремянка',
          unit: 'шт',
          unitCost: 30000,
          qty: '1',
        },
        { executor: tx, today: TODAY },
      );

      const moved = await transferItem(fixture.network, item.id, fixture.houseB, {
        executor: tx,
        today: TODAY,
      });

      expect(moved.houseId).toBe(fixture.houseB);
      expect(moved.areaId).toBeNull();
    });
  });

  it('зона ставится и снимается отдельным действием, с записью в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await withAreas(tx, '7105');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseA, name: 'Пылесос', unit: 'шт', unitCost: 50000, qty: '1' },
        { executor: tx, today: TODAY },
      );

      expect(item.areaId).toBeNull();

      const placed = await setItemArea(fixture.admin, item.id, fixture.kitchen, { executor: tx });
      expect(placed.areaId).toBe(fixture.kitchen);

      const removed = await setItemArea(fixture.admin, item.id, null, { executor: tx });
      expect(removed.areaId).toBeNull();

      const actions = (await tx.select().from(schema.auditLog)).map((entry) => entry.action);
      expect(actions.filter((action) => action === 'inventory_item.updated')).toHaveLength(2);
    });
  });

  it('чужую зону не поставить и отдельным действием', async () => {
    await inRollback(async (tx) => {
      const fixture = await withAreas(tx, '7106');

      const item = await receiveItem(
        fixture.network,
        { houseId: fixture.houseA, name: 'Ведро', unit: 'шт', unitCost: 1000, qty: '1' },
        { executor: tx, today: TODAY },
      );

      await expect(
        setItemArea(fixture.network, item.id, fixture.yardOfB, { executor: tx }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
