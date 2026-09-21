import {
  addMovement,
  closeAudit,
  createAudit,
  listAuditLines,
  listItems,
  replaceAuditLines,
  requireAudit,
  requireItem,
  saveAuditLine,
  updateItem,
} from '@/db/repositories/inventory';
import {
  applyMovement,
  auditDifference,
  formatQty,
  groupItemsByArea,
  parseQty,
} from '@/domain/inventory';
import { ConflictError, ValidationError } from '@/lib/errors';
import { toCsv, type Column } from '@/lib/export/csv';
import { toXlsx } from '@/lib/export/xlsx';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { assertInventoryHouse, resolveInventoryDeps, type InventoryDeps } from './inventory';

import type { InventoryItemWithArea } from '@/db/repositories/inventory';

import type { InventoryAudit, InventoryAuditLine, InventoryItem } from '@/db/schema';
import type { BusinessDate } from '@/lib/time';
import type { UserActor } from './users';

/**
 * Инвентаризация и выгрузка списков
 * (docs/04-MODULES/10-accounting-inventory.md, «Инвентарь»).
 *
 * Ведомость сверяет учёт с фактом, а закрытие превращает расхождения
 * в движения: остаток остаётся объяснимым историей, а не появляется
 * из ниоткуда после правки числа.
 */
export interface AuditSheetLine {
  itemId: string;
  name: string;
  unit: string;
  /** По учёту на момент составления ведомости. */
  expectedQty: string;
  /** По факту; `null` — строку ещё не считали. */
  actualQty: string | null;
  /** Расхождение в тех же единицах; `null` — не считали. */
  difference: string | null;
  comment: string | null;
}

export interface AuditSheet {
  audit: InventoryAudit;
  lines: AuditSheetLine[];
}

function sheetOf(
  audit: InventoryAudit,
  items: readonly InventoryItem[],
  lines: readonly InventoryAuditLine[],
): AuditSheet {
  const known = new Map(items.map((item) => [item.id, item]));

  return {
    audit,
    lines: lines.map((line) => {
      const difference = auditDifference(line.expectedQty, line.actualQty);

      return {
        itemId: line.itemId,
        name: known.get(line.itemId)?.name ?? '',
        unit: known.get(line.itemId)?.unit ?? '',
        expectedQty: line.expectedQty,
        actualQty: line.actualQty,
        difference: difference === null ? null : formatQty(difference),
        comment: line.comment,
      };
    }),
  };
}

/**
 * Начало инвентаризации: ведомость со всеми позициями дома.
 *
 * «По учёту» фиксируется сразу: если позиция изменится, пока ведомость
 * заполняют, сверять будут с тем числом, которое видели глазами.
 */
export async function startAudit(
  actor: UserActor,
  houseId: string,
  deps: InventoryDeps = {},
): Promise<AuditSheet> {
  const { executor, today } = resolveInventoryDeps(deps);

  assertInventoryHouse(actor, houseId, true);

  return executor.transaction(async (tx) => {
    const audit = await createAudit(actor.context, { houseId, date: today }, tx);
    const items = await listItems(actor.context, { houseId, status: 'in_use' }, tx);

    await replaceAuditLines(
      audit.id,
      items.map((item) => ({ itemId: item.id, expectedQty: item.qty })),
      tx,
    );

    return sheetOf(audit, items, await listAuditLines(audit.id, tx));
  });
}

export async function readAuditSheet(
  actor: UserActor,
  auditId: string,
  deps: InventoryDeps = {},
): Promise<AuditSheet> {
  const { executor } = resolveInventoryDeps(deps);

  const audit = await requireAudit(actor.context, auditId, executor);
  assertInventoryHouse(actor, audit.houseId, false);

  const [items, lines] = await Promise.all([
    listItems(actor.context, { houseId: audit.houseId }, executor),
    listAuditLines(auditId, executor),
  ]);

  return sheetOf(audit, items, lines);
}

/** Факт по строке: сколько нашли и что об этом думает считавший. */
export async function saveAuditFact(
  actor: UserActor,
  auditId: string,
  itemId: string,
  input: { actualQty: string | null; comment?: string | null },
  deps: InventoryDeps = {},
): Promise<AuditSheetLine> {
  const { executor } = resolveInventoryDeps(deps);

  const audit = await requireAudit(actor.context, auditId, executor);
  assertInventoryHouse(actor, audit.houseId, true);

  if (audit.status === 'closed') {
    throw new ConflictError('inventory.errors.auditClosed');
  }

  if (input.actualQty !== null && parseQty(input.actualQty) < 0) {
    throw new ValidationError('inventory.errors.qtyPositive');
  }

  const item = await requireItem(actor.context, itemId, executor);
  const saved = await saveAuditLine(
    auditId,
    itemId,
    {
      actualQty: input.actualQty,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    },
    executor,
  );

  const difference = auditDifference(saved.expectedQty, saved.actualQty);

  return {
    itemId,
    name: item.name,
    unit: item.unit,
    expectedQty: saved.expectedQty,
    actualQty: saved.actualQty,
    difference: difference === null ? null : formatQty(difference),
    comment: saved.comment,
  };
}

/**
 * Закрытие ведомости: расхождения превращаются в движения.
 *
 * Непроверенные строки не трогаются: «не считали» — это не «ноль».
 * Количество не переписывается напрямую, корректировка становится
 * движением `audit_adjust` и остаётся видимой в истории позиции.
 */
export async function closeInventoryAudit(
  actor: UserActor,
  auditId: string,
  deps: InventoryDeps = {},
): Promise<{ audit: InventoryAudit; adjusted: number }> {
  const { executor } = resolveInventoryDeps(deps);

  const audit = await requireAudit(actor.context, auditId, executor);
  assertInventoryHouse(actor, audit.houseId, true);

  if (audit.status === 'closed') {
    throw new ConflictError('inventory.errors.auditClosed');
  }

  return executor.transaction(async (tx) => {
    const lines = await listAuditLines(auditId, tx);
    let adjusted = 0;

    for (const line of lines) {
      const difference = auditDifference(line.expectedQty, line.actualQty);

      if (difference === null || difference === 0) {
        continue;
      }

      const item = await requireItem(actor.context, line.itemId, tx);

      await addMovement(
        actor.context,
        {
          itemId: line.itemId,
          type: 'audit_adjust',
          qty: formatQty(difference),
          date: audit.date as BusinessDate,
          toHouseId: audit.houseId,
          docRef: auditId,
        },
        tx,
      );

      await updateItem(
        actor.context,
        line.itemId,
        { qty: formatQty(applyMovement(parseQty(item.qty), 'audit_adjust', difference)) },
        tx,
      );

      adjusted += 1;
    }

    const closed = await closeAudit(actor.context, auditId, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.inventoryAuditClosed,
        entityType: 'inventory_audit',
        entityId: auditId,
        after: { adjusted, houseId: audit.houseId },
      },
      tx,
    );

    return { audit: closed, adjusted };
  });
}

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportedFile {
  filename: string;
  mime: string;
  body: string | Uint8Array;
}

/**
 * Выгрузка инвентаря дома.
 *
 * Количество уходит строкой, а не числом: `12.50` — это ровно две сотых
 * доли, и превращение его в `12.5` теряет заявленную точность. Выгрузку
 * читают глазами и сверяют, а не пересчитывают.
 */
/** Группа без зоны: так она называется в выгрузке. */
const WITHOUT_AREA = 'Без зоны';

/** Строка выгрузки: позиция или итог по зоне. */
type ExportRow =
  | { kind: 'item'; areaName: string; item: InventoryItemWithArea }
  | { kind: 'total'; areaName: string; positions: number; totalCost: number };

export async function exportInventory(
  actor: UserActor,
  houseId: string,
  format: ExportFormat,
  deps: InventoryDeps = {},
): Promise<ExportedFile> {
  const { executor, today } = resolveInventoryDeps(deps);

  assertInventoryHouse(actor, houseId, false);
  const items = await listItems(actor.context, { houseId }, executor);

  /*
   * Выгрузка идёт с разбивкой по зонам (модуль 10): строки сгруппированы,
   * после каждой группы — итог по зоне. Позиции без зоны собраны в группу
   * «Без зоны» и стоят последними: приписывать их к чужой зоне нельзя.
   *
   * Итог — отдельная строка того же листа, а не второй лист: ведомость
   * читают глазами и сверяют, а не открывают в двух вкладках.
   */
  const rows: ExportRow[] = [];

  for (const group of groupItemsByArea(items)) {
    const areaName = group.areaName ?? WITHOUT_AREA;

    for (const item of group.items) {
      rows.push({ kind: 'item', areaName, item });
    }

    rows.push({
      kind: 'total',
      areaName,
      positions: group.items.length,
      totalCost: group.totalCost,
    });
  }

  const columns: Column<ExportRow>[] = [
    { header: 'Зона', value: (row) => row.areaName },
    {
      header: 'Наименование',
      value: (row) =>
        row.kind === 'item' ? row.item.name : `Итого позиций: ${String(row.positions)}`,
    },
    { header: 'Количество', value: (row) => (row.kind === 'item' ? row.item.qty : '') },
    { header: 'Единица', value: (row) => (row.kind === 'item' ? row.item.unit : '') },
    {
      header: 'Стоимость единицы',
      value: (row) => (row.kind === 'item' ? row.item.unitCost : ''),
    },
    {
      header: 'Стоимость зоны',
      value: (row) => (row.kind === 'total' ? row.totalCost : ''),
    },
    { header: 'Статус', value: (row) => (row.kind === 'item' ? row.item.status : '') },
    { header: 'Принято', value: (row) => (row.kind === 'item' ? row.item.acquiredAt : '') },
    { header: 'Примечание', value: (row) => (row.kind === 'item' ? row.item.note : '') },
  ];

  if (format === 'csv') {
    return {
      filename: `inventory-${today}.csv`,
      mime: 'text/csv; charset=utf-8',
      body: toCsv(columns, rows),
    };
  }

  return {
    filename: `inventory-${today}.xlsx`,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: toXlsx(columns, rows, 'Инвентарь'),
  };
}
