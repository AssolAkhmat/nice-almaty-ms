import { getDb, type Executor } from '@/db/client';
import {
  addMovement,
  createItem,
  listItems,
  listMovements,
  requireItem,
  updateItem,
  type CreateItemInput,
  type ItemFilter,
} from '@/db/repositories/inventory';
import { applyMovement, formatQty, parseQty } from '@/domain/inventory';
import { assertCan } from '@/lib/authz';
import { ConflictError, ValidationError } from '@/lib/errors';
import { now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { InventoryItem, InventoryMovement } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Инвентарь дома (docs/04-MODULES/10-accounting-inventory.md, «Инвентарь»).
 *
 * Количество позиции — следствие движений: приход прибавляет, списание
 * вычитает, перемещение меняет дом. Правка количества руками не
 * предусмотрена намеренно — иначе история перестала бы объяснять остаток.
 */
export interface InventoryDeps {
  executor?: Executor;
  today?: BusinessDate;
}

export function resolveInventoryDeps(deps: InventoryDeps): {
  executor: Executor;
  today: BusinessDate;
} {
  return {
    executor: deps.executor ?? getDb(),
    today: deps.today ?? todayInAlmaty(now()),
  };
}

/** Права на инвентарь идут по дому: админ ведёт только свой (§«Инвентарь»). */
export function assertInventoryHouse(actor: UserActor, houseId: string, write: boolean): void {
  assertCan(actor.context, write ? 'inventory.manage' : 'inventory.read', { houseId });
}

function assertPositive(qty: string): number {
  const amount = parseQty(qty);

  if (amount <= 0) {
    throw new ValidationError('inventory.errors.qtyPositive');
  }

  return amount;
}

export async function listInventory(
  actor: UserActor,
  filter: ItemFilter = {},
  deps: InventoryDeps = {},
): Promise<InventoryItem[]> {
  const { executor } = resolveInventoryDeps(deps);

  if (filter.houseId !== undefined) {
    assertInventoryHouse(actor, filter.houseId, false);
  }

  return listItems(actor.context, filter, executor);
}

export async function readItemHistory(
  actor: UserActor,
  itemId: string,
  deps: InventoryDeps = {},
): Promise<{ item: InventoryItem; movements: InventoryMovement[] }> {
  const { executor } = resolveInventoryDeps(deps);

  const item = await requireItem(actor.context, itemId, executor);
  assertInventoryHouse(actor, item.houseId, false);

  return { item, movements: await listMovements(actor.context, itemId, executor) };
}

export interface AddItemInput extends CreateItemInput {
  /** Начальное количество: приход, с которого позиция появляется в доме. */
  qty: string;
}

/**
 * Приход: позиция и первое движение одной записью.
 *
 * Позиция без прихода — это ноль на складе; заводить её отдельно от
 * количества значило бы разрешить остаток, которого никто не приносил.
 */
export async function receiveItem(
  actor: UserActor,
  input: AddItemInput,
  deps: InventoryDeps = {},
): Promise<InventoryItem> {
  const { executor, today } = resolveInventoryDeps(deps);

  assertInventoryHouse(actor, input.houseId, true);
  const amount = assertPositive(input.qty);

  if (input.name.trim() === '' || input.unit.trim() === '') {
    throw new ValidationError('inventory.errors.nameRequired');
  }

  return executor.transaction(async (tx) => {
    const item = await createItem(
      actor.context,
      { ...input, name: input.name.trim(), unit: input.unit.trim() },
      tx,
    );

    await addMovement(
      actor.context,
      {
        itemId: item.id,
        type: 'in',
        qty: formatQty(amount),
        date: input.acquiredAt ?? today,
        toHouseId: item.houseId,
      },
      tx,
    );

    const stocked = await updateItem(actor.context, item.id, { qty: formatQty(amount) }, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.inventoryItemCreated,
        entityType: 'inventory_item',
        entityId: item.id,
        after: { name: stocked.name, qty: stocked.qty, houseId: stocked.houseId },
      },
      tx,
    );

    return stocked;
  });
}

/** Расход или списание: количество уменьшается, история остаётся. */
export async function consumeItem(
  actor: UserActor,
  itemId: string,
  input: { qty: string; type: 'out' | 'write_off'; docRef?: string | null },
  deps: InventoryDeps = {},
): Promise<InventoryItem> {
  const { executor, today } = resolveInventoryDeps(deps);

  const item = await requireItem(actor.context, itemId, executor);
  assertInventoryHouse(actor, item.houseId, true);

  const amount = assertPositive(input.qty);
  const rest = applyMovement(parseQty(item.qty), input.type, amount);

  if (rest < 0) {
    throw new ConflictError('inventory.errors.notEnough');
  }

  return executor.transaction(async (tx) => {
    await addMovement(
      actor.context,
      {
        itemId,
        type: input.type,
        qty: formatQty(amount),
        date: today,
        fromHouseId: item.houseId,
        docRef: input.docRef ?? null,
      },
      tx,
    );

    const updated = await updateItem(
      actor.context,
      itemId,
      {
        qty: formatQty(rest),
        // Списанное подчистую перестаёт числиться в доме, но не исчезает.
        ...(rest === 0 && input.type === 'write_off' ? { status: 'written_off' as const } : {}),
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action:
          input.type === 'write_off'
            ? AUDIT_ACTIONS.inventoryWrittenOff
            : AUDIT_ACTIONS.inventoryItemUpdated,
        entityType: 'inventory_item',
        entityId: itemId,
        before: { qty: item.qty },
        after: { qty: updated.qty },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Перемещение между домами.
 *
 * Позиция переезжает целиком: количество не меняется, меняется дом.
 * Дробить позицию на два дома нельзя — тогда это две разные позиции,
 * и завести вторую честнее, чем делить одну.
 */
export async function transferItem(
  actor: UserActor,
  itemId: string,
  toHouseId: string,
  deps: InventoryDeps = {},
): Promise<InventoryItem> {
  const { executor, today } = resolveInventoryDeps(deps);

  const item = await requireItem(actor.context, itemId, executor);

  /*
   * Оба дома проверяются на запись: перемещение — это одновременно
   * убытие из одного дома и приход в другой, и админ, ведущий только
   * свой дом, не вправе распорядиться чужим.
   */
  assertInventoryHouse(actor, item.houseId, true);
  assertInventoryHouse(actor, toHouseId, true);

  if (item.houseId === toHouseId) {
    throw new ConflictError('inventory.errors.sameHouse');
  }

  return executor.transaction(async (tx) => {
    await addMovement(
      actor.context,
      {
        itemId,
        type: 'transfer',
        qty: item.qty,
        date: today,
        fromHouseId: item.houseId,
        toHouseId,
      },
      tx,
    );

    const moved = await updateItem(actor.context, itemId, { houseId: toHouseId }, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.inventoryMoved,
        entityType: 'inventory_item',
        entityId: itemId,
        before: { houseId: item.houseId },
        after: { houseId: toHouseId },
      },
      tx,
    );

    return moved;
  });
}
