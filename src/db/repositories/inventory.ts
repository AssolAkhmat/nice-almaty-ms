import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  inventoryAuditLines,
  inventoryAudits,
  inventoryItems,
  inventoryMovements,
  type InventoryAudit,
  type InventoryAuditLine,
  type InventoryItem,
  type InventoryMovement,
} from '../schema';

/**
 * Инвентарь (docs/04-MODULES/10-accounting-inventory.md, «Инвентарь»).
 *
 * Позиция принадлежит дому, и админ ведёт только свой: чужой дом
 * неотличим от несуществующего (P1-1). Количества — `numeric(12,2)`,
 * в TypeScript они приходят строками, и складывать их здесь нельзя:
 * расчёт живёт в `src/domain/inventory.ts`.
 */
function houseScope(
  context: AccessContext,
  column: typeof inventoryItems.houseId | typeof inventoryAudits.houseId,
) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return sql`true`;
  }

  return visible.length === 0 ? sql`false` : inArray(column, [...visible]);
}

export interface ItemFilter {
  houseId?: string;
  status?: InventoryItem['status'];
}

export async function listItems(
  context: AccessContext,
  filter: ItemFilter = {},
  executor: Executor = getDb(),
): Promise<InventoryItem[]> {
  const conditions = [
    eq(inventoryItems.orgId, context.orgId),
    houseScope(context, inventoryItems.houseId),
  ];

  if (filter.houseId !== undefined) {
    assertHouseVisible(context, filter.houseId);
    conditions.push(eq(inventoryItems.houseId, filter.houseId));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(inventoryItems.status, filter.status));
  }

  return executor
    .select()
    .from(inventoryItems)
    .where(and(...conditions))
    .orderBy(asc(inventoryItems.name), asc(inventoryItems.id));
}

export async function findItem(
  context: AccessContext,
  itemId: string,
  executor: Executor = getDb(),
): Promise<InventoryItem | null> {
  const [item] = await executor
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.orgId, context.orgId),
        houseScope(context, inventoryItems.houseId),
        eq(inventoryItems.id, itemId),
      ),
    )
    .limit(1);

  return item ?? null;
}

export async function requireItem(
  context: AccessContext,
  itemId: string,
  executor: Executor = getDb(),
): Promise<InventoryItem> {
  const item = await findItem(context, itemId, executor);

  if (item === null) {
    throw new NotFoundError('Позиция инвентаря не найдена');
  }

  return item;
}

export interface CreateItemInput {
  houseId: string;
  name: string;
  unit: string;
  unitCost: number;
  responsibleUserId?: string | null;
  acquiredAt?: BusinessDate | null;
  note?: string | null;
}

export async function createItem(
  context: AccessContext,
  input: CreateItemInput,
  executor: Executor = getDb(),
): Promise<InventoryItem> {
  assertHouseVisible(context, input.houseId);

  const [item] = await executor
    .insert(inventoryItems)
    .values({
      orgId: context.orgId,
      houseId: input.houseId,
      name: input.name,
      unit: input.unit,
      unitCost: input.unitCost,
      responsibleUserId: input.responsibleUserId ?? null,
      acquiredAt: input.acquiredAt ?? null,
      note: input.note ?? null,
    })
    .returning();

  if (item === undefined) {
    throw new Error('Позиция инвентаря не создана');
  }

  return item;
}

export interface UpdateItemInput {
  name?: string;
  unit?: string;
  unitCost?: number;
  responsibleUserId?: string | null;
  status?: InventoryItem['status'];
  note?: string | null;
  /** Количество приходит уже посчитанным: репозиторий сам ничего не складывает. */
  qty?: string;
  houseId?: string;
}

export async function updateItem(
  context: AccessContext,
  itemId: string,
  patch: UpdateItemInput,
  executor: Executor = getDb(),
): Promise<InventoryItem> {
  await requireItem(context, itemId, executor);

  if (patch.houseId !== undefined) {
    assertHouseVisible(context, patch.houseId);
  }

  const [item] = await executor
    .update(inventoryItems)
    .set({ ...patch, updatedAt: now() })
    .where(eq(inventoryItems.id, itemId))
    .returning();

  if (item === undefined) {
    throw new NotFoundError('Позиция инвентаря не найдена');
  }

  return item;
}

export interface MovementInput {
  itemId: string;
  type: InventoryMovement['type'];
  qty: string;
  date: BusinessDate;
  fromHouseId?: string | null;
  toHouseId?: string | null;
  docRef?: string | null;
}

export async function addMovement(
  context: AccessContext,
  input: MovementInput,
  executor: Executor = getDb(),
): Promise<InventoryMovement> {
  const [movement] = await executor
    .insert(inventoryMovements)
    .values({
      orgId: context.orgId,
      itemId: input.itemId,
      type: input.type,
      qty: input.qty,
      date: input.date,
      fromHouseId: input.fromHouseId ?? null,
      toHouseId: input.toHouseId ?? null,
      docRef: input.docRef ?? null,
      createdBy: context.userId,
    })
    .returning();

  if (movement === undefined) {
    throw new Error('Движение инвентаря не создано');
  }

  return movement;
}

/** История позиции: новые сверху, как её читает человек. */
export async function listMovements(
  context: AccessContext,
  itemId: string,
  executor: Executor = getDb(),
): Promise<InventoryMovement[]> {
  await requireItem(context, itemId, executor);

  return executor
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.itemId, itemId))
    .orderBy(
      desc(inventoryMovements.date),
      desc(inventoryMovements.createdAt),
      desc(inventoryMovements.id),
    );
}

export async function createAudit(
  context: AccessContext,
  input: { houseId: string; date: BusinessDate },
  executor: Executor = getDb(),
): Promise<InventoryAudit> {
  assertHouseVisible(context, input.houseId);

  const [audit] = await executor
    .insert(inventoryAudits)
    .values({
      orgId: context.orgId,
      houseId: input.houseId,
      date: input.date,
      createdBy: context.userId,
    })
    .returning();

  if (audit === undefined) {
    throw new Error('Инвентаризация не создана');
  }

  return audit;
}

export async function listAudits(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<InventoryAudit[]> {
  assertHouseVisible(context, houseId);

  return executor
    .select()
    .from(inventoryAudits)
    .where(
      and(
        eq(inventoryAudits.orgId, context.orgId),
        houseScope(context, inventoryAudits.houseId),
        eq(inventoryAudits.houseId, houseId),
      ),
    )
    .orderBy(desc(inventoryAudits.date), desc(inventoryAudits.id));
}

export async function requireAudit(
  context: AccessContext,
  auditId: string,
  executor: Executor = getDb(),
): Promise<InventoryAudit> {
  const [audit] = await executor
    .select()
    .from(inventoryAudits)
    .where(
      and(
        eq(inventoryAudits.orgId, context.orgId),
        houseScope(context, inventoryAudits.houseId),
        eq(inventoryAudits.id, auditId),
      ),
    )
    .limit(1);

  if (audit === undefined) {
    throw new NotFoundError('Инвентаризация не найдена');
  }

  return audit;
}

export async function closeAudit(
  context: AccessContext,
  auditId: string,
  executor: Executor = getDb(),
): Promise<InventoryAudit> {
  await requireAudit(context, auditId, executor);

  const [audit] = await executor
    .update(inventoryAudits)
    .set({ status: 'closed', closedAt: now(), updatedAt: now() })
    .where(eq(inventoryAudits.id, auditId))
    .returning();

  if (audit === undefined) {
    throw new NotFoundError('Инвентаризация не найдена');
  }

  return audit;
}

export async function replaceAuditLines(
  auditId: string,
  lines: readonly { itemId: string; expectedQty: string }[],
  executor: Executor = getDb(),
): Promise<void> {
  await executor.delete(inventoryAuditLines).where(eq(inventoryAuditLines.auditId, auditId));

  if (lines.length === 0) {
    return;
  }

  await executor
    .insert(inventoryAuditLines)
    .values(lines.map((line) => ({ auditId, itemId: line.itemId, expectedQty: line.expectedQty })));
}

export async function listAuditLines(
  auditId: string,
  executor: Executor = getDb(),
): Promise<InventoryAuditLine[]> {
  return executor
    .select()
    .from(inventoryAuditLines)
    .where(eq(inventoryAuditLines.auditId, auditId))
    .orderBy(asc(inventoryAuditLines.createdAt), asc(inventoryAuditLines.id));
}

export async function saveAuditLine(
  auditId: string,
  itemId: string,
  patch: { actualQty?: string | null; comment?: string | null },
  executor: Executor = getDb(),
): Promise<InventoryAuditLine> {
  const [line] = await executor
    .update(inventoryAuditLines)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(inventoryAuditLines.auditId, auditId), eq(inventoryAuditLines.itemId, itemId)))
    .returning();

  if (line === undefined) {
    throw new NotFoundError('Строка ведомости не найдена');
  }

  return line;
}
