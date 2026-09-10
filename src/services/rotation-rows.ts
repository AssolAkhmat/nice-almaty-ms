import { getDb, type Executor } from '@/db/client';
import { listAreas, listBeds } from '@/db/repositories/areas';
import {
  createRotationRow,
  listChecklists,
  listRotationRows,
  listRowSlots,
  listRowZones,
  replaceRowSlots,
  replaceRowZones,
  requireRotationRow,
  updateRotationRow,
} from '@/db/repositories/rotations';
import { rotationVector } from '@/domain/rotation-grid';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, toAlmatyParts, startOfDayUtc, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type {
  Area,
  AreaChecklist,
  Bed,
  RotationRow,
  RotationRowSlot,
  RotationRowZone,
} from '@/db/schema';
import type { UserActor } from './users';

/**
 * Ряды ротаций (docs/03-BUSINESS-RULES.md §6.1, §6.4).
 *
 * Ряд — это дом, день недели, дата первой ротации, упорядоченные места
 * и упорядоченные зоны. Инвариант 9 (`D <= S`) проверяется той же формулой,
 * по которой потом считается сетка: расходиться им нельзя.
 *
 * Слот держится места, а не человека: сменился жилец — позиция в цикле
 * осталась, и ряд не пересобирается (§6.1).
 */
export interface RotationRowsDeps {
  executor?: Executor;
  includeInactive?: boolean;
}

function executorOf(deps: RotationRowsDeps): Executor {
  return deps.executor ?? getDb();
}

export interface RowSlotInput {
  bedId: string;
}

export interface RowZoneInput {
  areaId: string;
  checklistId: string;
}

export interface RowInput {
  /** Пусто — заводится новый ряд; заполнено — правится существующий. */
  rowId?: string;
  houseId: string;
  name: string;
  type: 'common' | 'room';
  /** 0 — воскресенье, 6 — суббота. */
  weekday: number;
  startDate: BusinessDate;
  /** Порядок в списке и есть порядок в цикле. */
  slots: readonly RowSlotInput[];
  zones: readonly RowZoneInput[];
  sortOrder?: number;
}

export interface RotationRowView {
  row: RotationRow;
  slots: RotationRowSlot[];
  zones: RotationRowZone[];
}

export async function readRows(
  actor: UserActor,
  houseId: string,
  deps: RotationRowsDeps = {},
): Promise<RotationRowView[]> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.read', { houseId });

  const rows = await listRotationRows(
    actor.context,
    houseId,
    deps.includeInactive === true ? { includeInactive: true } : {},
    executor,
  );

  const views: RotationRowView[] = [];

  for (const row of rows) {
    views.push({
      row,
      slots: await listRowSlots(actor.context, row.id, executor),
      zones: await listRowZones(actor.context, row.id, executor),
    });
  }

  return views;
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new ValidationError('rotationRows.errors.nameRequired');
  }

  return trimmed;
}

/** День недели даты по календарю Алматы: 0 — воскресенье, 6 — суббота. */
function weekdayOf(date: BusinessDate): number {
  return toAlmatyParts(startOfDayUtc(date)).weekday;
}

function assertSchedule(input: RowInput): BusinessDate {
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    throw new ValidationError('rotationRows.errors.weekdayInvalid');
  }

  // Комнатные ряды идут по воскресеньям (§6.4) — это часть их определения,
  // а не настройка: комната достаётся одному жильцу на неделю.
  if (input.type === 'room' && input.weekday !== 0) {
    throw new ValidationError('rotationRows.errors.roomRowSunday');
  }

  const startDate = parseBusinessDate(input.startDate);

  // Дата первой ротации — от неё считается номер недели `k` (§6.2).
  // Не совпав с днём недели ряда, она сдвинула бы всю сетку на день.
  if (weekdayOf(startDate) !== input.weekday) {
    throw new ValidationError('rotationRows.errors.startDateWeekday');
  }

  return startDate;
}

interface HouseParts {
  areas: Map<string, Area>;
  beds: Map<string, Bed>;
  checklists: Map<string, AreaChecklist>;
}

async function readHouseParts(
  actor: UserActor,
  houseId: string,
  executor: Executor,
): Promise<HouseParts> {
  const [areas, beds, checklists] = await Promise.all([
    listAreas(actor.context, houseId, {}, executor),
    listBeds(actor.context, houseId, {}, executor),
    listChecklists(actor.context, houseId, {}, executor),
  ]);

  return {
    areas: new Map(areas.map((area) => [area.id, area])),
    beds: new Map(beds.map((bed) => [bed.id, bed])),
    checklists: new Map(checklists.map((checklist) => [checklist.id, checklist])),
  };
}

/** Слоты ряда: места своего дома, каждое по разу, в заданном порядке. */
function resolveSlots(input: RowInput, parts: HouseParts): { position: number; bedId: string }[] {
  if (input.slots.length === 0) {
    throw new ValidationError('rotationRows.errors.slotsRequired');
  }

  const seen = new Set<string>();

  return input.slots.map((slot, position) => {
    if (!parts.beds.has(slot.bedId)) {
      // Чужое место неотличимо от несуществующего (P1-1).
      throw new NotFoundError('Место не найдено');
    }

    if (seen.has(slot.bedId)) {
      throw new ValidationError('rotationRows.errors.bedTwice');
    }

    seen.add(slot.bedId);

    return { position, bedId: slot.bedId };
  });
}

/** Зоны ряда вместе с числом людей, переписанным из чек-листа. */
function resolveZones(
  input: RowInput,
  parts: HouseParts,
): { position: number; areaId: string; checklistId: string; peopleNeeded: number }[] {
  if (input.zones.length === 0) {
    throw new ValidationError('rotationRows.errors.zonesRequired');
  }

  if (input.type === 'room' && input.zones.length !== 1) {
    throw new ValidationError('rotationRows.errors.roomRowSingleZone');
  }

  return input.zones.map((zone, position) => {
    const area = parts.areas.get(zone.areaId);
    if (area === undefined) {
      throw new NotFoundError('Зона не найдена');
    }

    const checklist = parts.checklists.get(zone.checklistId);
    if (checklist === undefined) {
      throw new NotFoundError('Чек-лист не найден');
    }

    // Чек-лист чужой зоны означал бы, что убирают одно, а спрашивают другое.
    if (checklist.areaId !== zone.areaId) {
      throw new ValidationError('rotationRows.errors.checklistArea');
    }

    if (input.type === 'room' && area.type !== 'living') {
      throw new ValidationError('rotationRows.errors.roomRowLivingArea');
    }

    return {
      position,
      areaId: zone.areaId,
      checklistId: zone.checklistId,
      peopleNeeded: checklist.peopleNeeded,
    };
  });
}

/**
 * Комнатный ряд ходит по кругу внутри своей комнаты, поэтому его слоты —
 * места этой же комнаты. Место из другой комнаты дало бы жильцу чужую
 * уборку, а комнате — исполнителя, который в ней не живёт.
 */
function assertRoomSlots(
  input: RowInput,
  parts: HouseParts,
  zones: readonly { areaId: string }[],
): void {
  if (input.type !== 'room') {
    return;
  }

  const roomId = zones[0]?.areaId;

  for (const slot of input.slots) {
    if (parts.beds.get(slot.bedId)?.areaId !== roomId) {
      throw new ValidationError('rotationRows.errors.roomRowSlots');
    }
  }
}

/**
 * Инвариант 9 проверяется той самой формулой, по которой считается сетка:
 * вектор обязанностей длиннее числа слотов собран быть не может.
 */
function assertInvariantNine(
  slots: readonly unknown[],
  zones: readonly { areaId: string; checklistId: string; peopleNeeded: number }[],
): void {
  try {
    rotationVector(zones, slots.length);
  } catch {
    throw new ValidationError('rotationRows.errors.tooManyDuties');
  }
}

export async function saveRow(
  actor: UserActor,
  input: RowInput,
  deps: RotationRowsDeps = {},
): Promise<RotationRow> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.write', { houseId: input.houseId });

  const name = assertName(input.name);
  const startDate = assertSchedule(input);

  const parts = await readHouseParts(actor, input.houseId, executor);
  const zones = resolveZones(input, parts);
  const slots = resolveSlots(input, parts);

  assertRoomSlots(input, parts, zones);
  assertInvariantNine(slots, zones);

  const existing =
    input.rowId === undefined
      ? null
      : await requireRotationRow(actor.context, input.rowId, executor);

  return executor.transaction(async (tx) => {
    const row =
      existing === null
        ? await createRotationRow(
            actor.context,
            {
              houseId: input.houseId,
              name,
              type: input.type,
              weekday: input.weekday,
              startDate,
              // Комната ряда — та самая единственная зона комнатного ряда (§6.4).
              roomAreaId: input.type === 'room' ? (zones[0]?.areaId ?? null) : null,
              ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
            },
            tx,
          )
        : await updateRotationRow(
            actor.context,
            existing.id,
            {
              name,
              type: input.type,
              weekday: input.weekday,
              startDate,
              roomAreaId: input.type === 'room' ? (zones[0]?.areaId ?? null) : null,
              isActive: true,
              ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
            },
            tx,
          );

    await replaceRowSlots(actor.context, row.id, slots, tx);
    await replaceRowZones(actor.context, row.id, zones, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationRowSaved,
        entityType: 'rotation_row',
        entityId: row.id,
        before:
          existing === null
            ? undefined
            : { name: existing.name, weekday: existing.weekday, startDate: existing.startDate },
        after: {
          houseId: input.houseId,
          name,
          type: input.type,
          weekday: input.weekday,
          startDate,
          slots: slots.length,
          zones: zones.length,
        },
      },
      tx,
    );

    return row;
  });
}

/**
 * Ряд не удаляется, а выключается: занятия, уже сгенерированные по нему,
 * ссылаются на ряд, и удаление стёрло бы историю уборок вместе с ним.
 */
export async function archiveRow(
  actor: UserActor,
  rowId: string,
  deps: RotationRowsDeps = {},
): Promise<RotationRow> {
  const executor = executorOf(deps);

  const row = await requireRotationRow(actor.context, rowId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: row.houseId });

  return executor.transaction(async (tx) => {
    const archived = await updateRotationRow(actor.context, rowId, { isActive: false }, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationRowArchived,
        entityType: 'rotation_row',
        entityId: rowId,
        before: { name: row.name },
      },
      tx,
    );

    return archived;
  });
}
