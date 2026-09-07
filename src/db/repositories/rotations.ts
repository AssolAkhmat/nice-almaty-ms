import { and, asc, between, eq, inArray, isNull, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  areaChecklists,
  areas,
  eligibilityGroups,
  rotationOccurrences,
  rotationRowSlots,
  rotationRowZones,
  rotationRows,
  rotationTemplatesSettings,
  type AreaChecklist,
  type EligibilityGroup,
  type RotationOccurrence,
  type RotationRow,
  type RotationRowSlot,
  type RotationRowZone,
  type RotationTemplateSettings,
} from '../schema';

/**
 * Ротации: чек-листы, группы допуска, ряды и материализованные занятия.
 *
 * Каждый список фильтруется по дому — админ соседнего дома не должен узнать
 * даже, сколько там рядов. Чек-лист дома не хранит: он висит на зоне,
 * и видимость идёт через неё, чтобы дом у зоны и у чек-листа не разошлись.
 */
type ChecklistType = 'regular' | 'general';

function houseScope(
  context: AccessContext,
  column:
    | typeof areas.houseId
    | typeof rotationRows.houseId
    | typeof rotationOccurrences.houseId
    | typeof eligibilityGroups.houseId
    | typeof rotationTemplatesSettings.houseId,
) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return sql`true`;
  }

  return visible.length === 0 ? sql`false` : inArray(column, [...visible]);
}

/** Зона видимого дома. Чужая и несуществующая неотличимы (P1-1). */
async function requireVisibleArea(
  context: AccessContext,
  areaId: string,
  executor: Executor,
): Promise<{ id: string; houseId: string }> {
  const [area] = await executor
    .select({ id: areas.id, houseId: areas.houseId })
    .from(areas)
    .where(and(eq(areas.id, areaId), houseScope(context, areas.houseId)))
    .limit(1);

  if (area === undefined) {
    throw new NotFoundError('Зона не найдена');
  }

  return area;
}

export interface CreateChecklistInput {
  areaId: string;
  type: ChecklistType;
  title: string;
  /** Пункты на языке дома: их заводит админ, а не система. */
  items?: readonly string[];
  peopleNeeded?: number;
}

export async function createChecklist(
  context: AccessContext,
  input: CreateChecklistInput,
  executor: Executor = getDb(),
): Promise<AreaChecklist> {
  await requireVisibleArea(context, input.areaId, executor);

  const [checklist] = await executor
    .insert(areaChecklists)
    .values({
      areaId: input.areaId,
      type: input.type,
      title: input.title,
      items: input.items ?? [],
      peopleNeeded: input.peopleNeeded ?? 1,
    })
    .returning();

  if (checklist === undefined) {
    throw new Error('Чек-лист не создан');
  }

  return checklist;
}

export async function listChecklists(
  context: AccessContext,
  houseId: string,
  options: { includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<AreaChecklist[]> {
  assertHouseVisible(context, houseId);

  const conditions = [eq(areas.houseId, houseId), houseScope(context, areas.houseId)];
  if (options.includeArchived !== true) {
    conditions.push(isNull(areaChecklists.archivedAt));
  }

  const rows = await executor
    .select({ checklist: areaChecklists })
    .from(areaChecklists)
    .innerJoin(areas, eq(areas.id, areaChecklists.areaId))
    .where(and(...conditions))
    .orderBy(asc(areas.sortOrder), asc(areas.name), asc(areaChecklists.type));

  return rows.map((row) => row.checklist);
}

export async function requireChecklist(
  context: AccessContext,
  checklistId: string,
  executor: Executor = getDb(),
): Promise<AreaChecklist> {
  const [row] = await executor
    .select({ checklist: areaChecklists })
    .from(areaChecklists)
    .innerJoin(areas, eq(areas.id, areaChecklists.areaId))
    .where(and(eq(areaChecklists.id, checklistId), houseScope(context, areas.houseId)))
    .limit(1);

  if (row === undefined) {
    throw new NotFoundError('Чек-лист не найден');
  }

  return row.checklist;
}

export interface UpdateChecklistInput {
  title?: string;
  items?: readonly string[];
  peopleNeeded?: number;
  archivedAt?: Date | null;
}

export async function updateChecklist(
  context: AccessContext,
  checklistId: string,
  patch: UpdateChecklistInput,
  executor: Executor = getDb(),
): Promise<AreaChecklist> {
  await requireChecklist(context, checklistId, executor);

  const [checklist] = await executor
    .update(areaChecklists)
    .set({
      ...patch,
      items: patch.items === undefined ? undefined : [...patch.items],
      updatedAt: now(),
    })
    .where(eq(areaChecklists.id, checklistId))
    .returning();

  if (checklist === undefined) {
    throw new NotFoundError('Чек-лист не найден');
  }

  return checklist;
}

export interface CreateEligibilityGroupInput {
  houseId: string;
  name: string;
  /** `{ base, areaId?, includeUserIds[], excludeUserIds[] }` — разбор в сервисе. */
  rule: unknown;
}

export async function createEligibilityGroup(
  context: AccessContext,
  input: CreateEligibilityGroupInput,
  executor: Executor = getDb(),
): Promise<EligibilityGroup> {
  assertHouseVisible(context, input.houseId);

  const [group] = await executor
    .insert(eligibilityGroups)
    .values({
      orgId: context.orgId,
      houseId: input.houseId,
      name: input.name,
      rule: input.rule,
    })
    .returning();

  if (group === undefined) {
    throw new Error('Группа допуска не создана');
  }

  return group;
}

export async function listEligibilityGroups(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<EligibilityGroup[]> {
  assertHouseVisible(context, houseId);

  return executor
    .select()
    .from(eligibilityGroups)
    .where(
      and(
        eq(eligibilityGroups.orgId, context.orgId),
        eq(eligibilityGroups.houseId, houseId),
        houseScope(context, eligibilityGroups.houseId),
      ),
    )
    .orderBy(asc(eligibilityGroups.name));
}

export interface CreateRotationRowInput {
  houseId: string;
  name: string;
  type: 'common' | 'room';
  /** 0 — воскресенье, 6 — суббота. */
  weekday: number;
  startDate: BusinessDate;
  sortOrder?: number;
}

export async function createRotationRow(
  context: AccessContext,
  input: CreateRotationRowInput,
  executor: Executor = getDb(),
): Promise<RotationRow> {
  assertHouseVisible(context, input.houseId);

  const [row] = await executor
    .insert(rotationRows)
    .values({
      orgId: context.orgId,
      houseId: input.houseId,
      name: input.name,
      type: input.type,
      weekday: input.weekday,
      startDate: input.startDate,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();

  if (row === undefined) {
    throw new Error('Ряд ротаций не создан');
  }

  return row;
}

export async function listRotationRows(
  context: AccessContext,
  houseId: string,
  options: { includeInactive?: boolean } = {},
  executor: Executor = getDb(),
): Promise<RotationRow[]> {
  assertHouseVisible(context, houseId);

  const conditions = [
    eq(rotationRows.orgId, context.orgId),
    eq(rotationRows.houseId, houseId),
    houseScope(context, rotationRows.houseId),
  ];
  if (options.includeInactive !== true) {
    conditions.push(eq(rotationRows.isActive, true));
  }

  return executor
    .select()
    .from(rotationRows)
    .where(and(...conditions))
    .orderBy(asc(rotationRows.sortOrder), asc(rotationRows.name));
}

export async function requireRotationRow(
  context: AccessContext,
  rowId: string,
  executor: Executor = getDb(),
): Promise<RotationRow> {
  const [row] = await executor
    .select()
    .from(rotationRows)
    .where(
      and(
        eq(rotationRows.id, rowId),
        eq(rotationRows.orgId, context.orgId),
        houseScope(context, rotationRows.houseId),
      ),
    )
    .limit(1);

  if (row === undefined) {
    throw new NotFoundError('Ряд ротаций не найден');
  }

  return row;
}

export interface RowSlotInput {
  position: number;
  bedId: string;
}

/**
 * Слоты ряда переписываются целиком: порядок позиций и есть состав ряда,
 * и правка по одной строке оставила бы дыру в середине цикла.
 */
export async function replaceRowSlots(
  context: AccessContext,
  rowId: string,
  slots: readonly RowSlotInput[],
  executor: Executor = getDb(),
): Promise<RotationRowSlot[]> {
  await requireRotationRow(context, rowId, executor);

  await executor.delete(rotationRowSlots).where(eq(rotationRowSlots.rowId, rowId));

  if (slots.length === 0) {
    return [];
  }

  return executor
    .insert(rotationRowSlots)
    .values(slots.map((slot) => ({ rowId, position: slot.position, bedId: slot.bedId })))
    .returning();
}

export async function listRowSlots(
  context: AccessContext,
  rowId: string,
  executor: Executor = getDb(),
): Promise<RotationRowSlot[]> {
  await requireRotationRow(context, rowId, executor);

  return executor
    .select()
    .from(rotationRowSlots)
    .where(eq(rotationRowSlots.rowId, rowId))
    .orderBy(asc(rotationRowSlots.position));
}

export interface RowZoneInput {
  position: number;
  areaId: string;
  checklistId: string;
  peopleNeeded: number;
}

export async function replaceRowZones(
  context: AccessContext,
  rowId: string,
  zones: readonly RowZoneInput[],
  executor: Executor = getDb(),
): Promise<RotationRowZone[]> {
  await requireRotationRow(context, rowId, executor);

  await executor.delete(rotationRowZones).where(eq(rotationRowZones.rowId, rowId));

  if (zones.length === 0) {
    return [];
  }

  return executor
    .insert(rotationRowZones)
    .values(
      zones.map((zone) => ({
        rowId,
        position: zone.position,
        areaId: zone.areaId,
        checklistId: zone.checklistId,
        peopleNeeded: zone.peopleNeeded,
      })),
    )
    .returning();
}

export async function listRowZones(
  context: AccessContext,
  rowId: string,
  executor: Executor = getDb(),
): Promise<RotationRowZone[]> {
  await requireRotationRow(context, rowId, executor);

  return executor
    .select()
    .from(rotationRowZones)
    .where(eq(rotationRowZones.rowId, rowId))
    .orderBy(asc(rotationRowZones.position));
}

export interface CreateOccurrenceInput {
  houseId: string;
  /** Пусто у генеральной и внеплановой: ряда за ними нет. */
  rowId?: string | null;
  areaId: string;
  checklistId: string;
  date: BusinessDate;
  type: 'regular' | 'room' | 'general' | 'extra';
  cycleIndex?: number | null;
  movedFromDate?: BusinessDate | null;
  createdBy?: string | null;
}

export async function createOccurrence(
  context: AccessContext,
  input: CreateOccurrenceInput,
  executor: Executor = getDb(),
): Promise<RotationOccurrence> {
  assertHouseVisible(context, input.houseId);

  const [occurrence] = await executor
    .insert(rotationOccurrences)
    .values({
      orgId: context.orgId,
      houseId: input.houseId,
      rowId: input.rowId ?? null,
      areaId: input.areaId,
      checklistId: input.checklistId,
      date: input.date,
      type: input.type,
      cycleIndex: input.cycleIndex ?? null,
      movedFromDate: input.movedFromDate ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  if (occurrence === undefined) {
    throw new Error('Занятие не создано');
  }

  return occurrence;
}

export async function listOccurrences(
  context: AccessContext,
  houseId: string,
  range: { from: BusinessDate; to: BusinessDate },
  executor: Executor = getDb(),
): Promise<RotationOccurrence[]> {
  assertHouseVisible(context, houseId);

  return executor
    .select()
    .from(rotationOccurrences)
    .where(
      and(
        eq(rotationOccurrences.orgId, context.orgId),
        eq(rotationOccurrences.houseId, houseId),
        houseScope(context, rotationOccurrences.houseId),
        between(rotationOccurrences.date, range.from, range.to),
      ),
    )
    .orderBy(asc(rotationOccurrences.date), asc(rotationOccurrences.createdAt));
}

export interface TemplateSettingsInput {
  headerI18n: unknown;
  footerI18n: unknown;
}

export async function putTemplateSettings(
  context: AccessContext,
  houseId: string,
  type: ChecklistType,
  values: TemplateSettingsInput,
  executor: Executor = getDb(),
): Promise<RotationTemplateSettings> {
  assertHouseVisible(context, houseId);

  const [settings] = await executor
    .insert(rotationTemplatesSettings)
    .values({
      houseId,
      type,
      headerI18n: values.headerI18n,
      footerI18n: values.footerI18n,
    })
    .onConflictDoUpdate({
      target: [rotationTemplatesSettings.houseId, rotationTemplatesSettings.type],
      set: {
        headerI18n: values.headerI18n,
        footerI18n: values.footerI18n,
        updatedAt: now(),
      },
    })
    .returning();

  if (settings === undefined) {
    throw new Error('Шаблон не сохранён');
  }

  return settings;
}

export async function readTemplateSettings(
  context: AccessContext,
  houseId: string,
  type: ChecklistType,
  executor: Executor = getDb(),
): Promise<RotationTemplateSettings | null> {
  assertHouseVisible(context, houseId);

  const [settings] = await executor
    .select()
    .from(rotationTemplatesSettings)
    .where(
      and(
        eq(rotationTemplatesSettings.houseId, houseId),
        eq(rotationTemplatesSettings.type, type),
        houseScope(context, rotationTemplatesSettings.houseId),
      ),
    )
    .limit(1);

  return settings ?? null;
}
