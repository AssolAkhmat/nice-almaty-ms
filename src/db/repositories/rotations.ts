import { and, asc, between, eq, inArray, isNull, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  areaChecklists,
  areaEligibility,
  areas,
  bedAssignments,
  beds,
  eligibilityGroups,
  residencies,
  residentProfiles,
  rotationAssignments,
  rotationOccurrences,
  rotationDayNormZones,
  rotationDayNorms,
  rotationDebts,
  rotationRowRosterSlots,
  rotationRowRosters,
  rotationRowSlots,
  rotationRowZones,
  rotationRows,
  rotationTemplatesSettings,
  users,
  type AreaChecklist,
  type AreaEligibility,
  type RotationAssignment,
  type EligibilityGroup,
  type RotationOccurrence,
  type RotationRow,
  type RotationRowSlot,
  type RotationDebt,
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

/** Почему у зоны нет исполнителя (план фазы 10, §2.5). */
export type RotationEmptyReason = 'empty_bed' | 'absent' | 'not_eligible' | 'no_one';

function houseScope(
  context: AccessContext,
  column:
    | typeof areas.houseId
    | typeof beds.houseId
    | typeof rotationRows.houseId
    | typeof rotationOccurrences.houseId
    | typeof eligibilityGroups.houseId
    | typeof residencies.houseId
    | typeof rotationTemplatesSettings.houseId,
) {
  /*
   * Жилец не привязан к дому колонкой (D11), но своё расписание видит:
   * модуль 3 отдаёт ему календарь дома в режиме чтения. Связь идёт через
   * проживание — то же, чем видимость жильца устроена в остальных списках.
   */
  if (context.role === 'resident') {
    return sql`exists (
      select 1 from ${residencies}
      where ${residencies.userId} = ${context.userId}
        and ${residencies.houseId} = ${column}
        and ${residencies.status} in ('active', 'terminating')
    )`;
  }

  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return sql`true`;
  }

  return visible.length === 0 ? sql`false` : inArray(column, [...visible]);
}

/**
 * Дом, который контексту вообще позволено читать.
 *
 * Жильца проверяет не эта функция, а `houseScope`: у него дом не в контексте,
 * а в проживании, и чужой дом просто не даёт строк — вместо ответа «такого
 * дома нет», по которому перебором читался бы состав сети (P1-1).
 */
function assertHouseReadable(context: AccessContext, houseId: string): void {
  if (context.role === 'resident') {
    return;
  }

  assertHouseVisible(context, houseId);
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

/**
 * Долг по дополнительной ротации (§7): его заводят закрытие дня и порог
 * рейтинга. Дом у долга не хранится — человек может переехать, а долг
 * остаётся при нём до 1 июля.
 */
export async function createRotationDebt(
  input: {
    userId: string;
    reason: string;
    /** Шаг книги: `+1` — начисление, `−1` — списание; по умолчанию начисление. */
    delta?: 1 | -1;
    sourceAssignmentId?: string | null;
    expiresAt: BusinessDate;
  },
  executor: Executor = getDb(),
): Promise<void> {
  await executor.insert(rotationDebts).values({
    userId: input.userId,
    reason: input.reason,
    delta: input.delta ?? 1,
    sourceAssignmentId: input.sourceAssignmentId ?? null,
    expiresAt: input.expiresAt,
  });
}

export interface AssignmentDebtSync {
  assignmentId: string;
  userId: string | null;
  /** Строка, которую должно давать назначение сейчас; `0` — никакой. */
  step: -1 | 0 | 1;
  reason: string;
  expiresAt: BusinessDate;
}

/**
 * Книга долга следует за назначением (§7, план фазы 10 §2.7).
 *
 * У назначения не больше одной строки, и она отражает его нынешнее
 * состояние: отмена, возврат в расписание и отметка задним числом правят
 * ту же строку, а не начисляют вторую — так же, как событие рейтинга
 * держится за назначение (`putRefRatingEvent`). Строка, которая и так
 * верна, не переписывается: её дата и порядок остаются историей.
 */
export async function syncAssignmentDebt(
  input: AssignmentDebtSync,
  executor: Executor = getDb(),
): Promise<void> {
  const existing = await executor
    .select()
    .from(rotationDebts)
    .where(eq(rotationDebts.sourceAssignmentId, input.assignmentId));

  const wanted =
    input.step === 0 || input.userId === null ? null : { userId: input.userId, delta: input.step };

  const [current] = existing;

  if (
    wanted !== null &&
    existing.length === 1 &&
    current !== undefined &&
    current.delta === wanted.delta &&
    current.userId === wanted.userId
  ) {
    return;
  }

  if (existing.length > 0) {
    await executor
      .delete(rotationDebts)
      .where(eq(rotationDebts.sourceAssignmentId, input.assignmentId));
  }

  if (wanted !== null) {
    await executor.insert(rotationDebts).values({
      userId: wanted.userId,
      reason: input.reason,
      delta: wanted.delta,
      sourceAssignmentId: input.assignmentId,
      expiresAt: input.expiresAt,
    });
  }
}

/**
 * Строки долга жильцов на дату: видимость идёт через проживание.
 *
 * Долг не сгорает от времени, но живёт до 1 июля (§7): дата записана
 * в самом долге, поэтому год сбрасывается без переписывания строк —
 * они просто перестают попадать в выборку. Погашение вычитается не отсюда:
 * с фазы 10 книга ведётся со знаком, и списание — такая же строка с `−1`.
 */
export async function listRotationDebts(
  context: AccessContext,
  filter: { userIds: readonly string[]; on: BusinessDate },
  executor: Executor = getDb(),
): Promise<RotationDebt[]> {
  if (filter.userIds.length === 0) {
    return [];
  }

  const own = context.role === 'resident' ? [context.userId] : [...filter.userIds];

  return executor
    .select()
    .from(rotationDebts)
    .where(
      and(inArray(rotationDebts.userId, own), sql`${rotationDebts.expiresAt} > ${filter.on}::date`),
    )
    .orderBy(asc(rotationDebts.expiresAt), asc(rotationDebts.id));
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
    .orderBy(
      asc(areas.sortOrder),
      asc(areas.name),
      asc(areaChecklists.type),
      asc(areaChecklists.id),
    );

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
    .orderBy(asc(eligibilityGroups.name), asc(eligibilityGroups.id));
}

export async function requireEligibilityGroup(
  context: AccessContext,
  groupId: string,
  executor: Executor = getDb(),
): Promise<EligibilityGroup> {
  const [group] = await executor
    .select()
    .from(eligibilityGroups)
    .where(
      and(
        eq(eligibilityGroups.id, groupId),
        eq(eligibilityGroups.orgId, context.orgId),
        houseScope(context, eligibilityGroups.houseId),
      ),
    )
    .limit(1);

  if (group === undefined) {
    throw new NotFoundError('Группа допуска не найдена');
  }

  return group;
}

export interface UpdateEligibilityGroupInput {
  name?: string;
  rule?: unknown;
}

export async function updateEligibilityGroup(
  context: AccessContext,
  groupId: string,
  patch: UpdateEligibilityGroupInput,
  executor: Executor = getDb(),
): Promise<EligibilityGroup> {
  await requireEligibilityGroup(context, groupId, executor);

  const [group] = await executor
    .update(eligibilityGroups)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.rule === undefined ? {} : { rule: patch.rule }),
      updatedAt: now(),
    })
    .where(eq(eligibilityGroups.id, groupId))
    .returning();

  if (group === undefined) {
    throw new NotFoundError('Группа допуска не найдена');
  }

  return group;
}

/** Допуски всех зон дома: читается вместе с настройкой, поэтому одним запросом. */
export async function listAreaEligibility(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<AreaEligibility[]> {
  assertHouseVisible(context, houseId);

  const rows = await executor
    .select({ link: areaEligibility })
    .from(areaEligibility)
    .innerJoin(areas, eq(areas.id, areaEligibility.areaId))
    .where(and(eq(areas.houseId, houseId), houseScope(context, areas.houseId)))
    .orderBy(asc(areaEligibility.checklistType), asc(areaEligibility.id));

  return rows.map((row) => row.link);
}

/**
 * Допуск зоны переписывается целиком: список групп — это и есть допуск,
 * а правка по одной строке оставила бы зону наполовину открытой.
 */
export async function replaceAreaEligibility(
  context: AccessContext,
  areaId: string,
  checklistType: ChecklistType,
  groupIds: readonly string[],
  executor: Executor = getDb(),
): Promise<AreaEligibility[]> {
  await requireVisibleArea(context, areaId, executor);

  await executor
    .delete(areaEligibility)
    .where(
      and(eq(areaEligibility.areaId, areaId), eq(areaEligibility.checklistType, checklistType)),
    );

  if (groupIds.length === 0) {
    return [];
  }

  return executor
    .insert(areaEligibility)
    .values(groupIds.map((groupId) => ({ areaId, checklistType, groupId })))
    .returning();
}

export interface EligibilityMemberRow {
  userId: string;
  sex: 'male' | 'female' | null;
  areaId: string | null;
  /** Имя из профиля; пока профиль не заполнен — телефон. */
  name: string;
}

/**
 * Жильцы дома для групп допуска: пол из профиля, комната — из места,
 * назначенного сейчас. Съехавшие не попадают: убирать им уже нечего.
 */
export async function listEligibilityMembers(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<EligibilityMemberRow[]> {
  assertHouseVisible(context, houseId);

  const rows = await executor
    .select({
      userId: residencies.userId,
      sex: residentProfiles.sex,
      areaId: beds.areaId,
      lastName: residentProfiles.lastName,
      firstName: residentProfiles.firstName,
      phone: users.phone,
    })
    .from(residencies)
    .leftJoin(
      bedAssignments,
      and(eq(bedAssignments.residencyId, residencies.id), sql`upper_inf(${bedAssignments.period})`),
    )
    .leftJoin(beds, eq(beds.id, bedAssignments.bedId))
    .leftJoin(residentProfiles, eq(residentProfiles.userId, residencies.userId))
    .innerJoin(users, eq(users.id, residencies.userId))
    .where(
      and(
        eq(residencies.orgId, context.orgId),
        eq(residencies.houseId, houseId),
        inArray(residencies.status, ['active', 'terminating']),
      ),
    )
    /*
     * По имени, а не по времени заселения: у людей, заведённых одной
     * транзакцией, время совпадает, и порядок становится случайным —
     * от него зависят и состав группы, и раздача генеральной уборки.
     */
    .orderBy(
      asc(residentProfiles.lastName),
      asc(residentProfiles.firstName),
      asc(users.phone),
      asc(users.id),
    );

  return rows.map((row) => {
    const name = [row.lastName, row.firstName]
      .filter((part) => part !== null)
      .join(' ')
      .trim();

    return {
      userId: row.userId,
      sex: row.sex,
      areaId: row.areaId,
      name: name === '' ? row.phone : name,
    };
  });
}

export interface CreateRotationRowInput {
  houseId: string;
  name: string;
  type: 'common' | 'room';
  /** 0 — воскресенье, 6 — суббота. */
  weekday: number;
  startDate: BusinessDate;
  /** Комната ряда типа `room`: у ряда общих зон её нет (§6.4). */
  roomAreaId?: string | null;
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
      roomAreaId: input.type === 'room' ? (input.roomAreaId ?? null) : null,
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
    .orderBy(asc(rotationRows.sortOrder), asc(rotationRows.name), asc(rotationRows.id));
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

export interface UpdateRotationRowInput {
  name?: string;
  type?: 'common' | 'room';
  weekday?: number;
  startDate?: BusinessDate;
  /** Комната ряда: меняется вместе с типом, иначе база отобьёт правку. */
  roomAreaId?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export async function updateRotationRow(
  context: AccessContext,
  rowId: string,
  patch: UpdateRotationRowInput,
  executor: Executor = getDb(),
): Promise<RotationRow> {
  await requireRotationRow(context, rowId, executor);

  const [row] = await executor
    .update(rotationRows)
    .set({ ...patch, updatedAt: now() })
    .where(eq(rotationRows.id, rowId))
    .returning();

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
    .orderBy(asc(rotationRowSlots.position), asc(rotationRowSlots.id));
}

/**
 * Версии состава ряда и нормы дня (план фазы 10, §2.2, §2.3).
 *
 * Правка «с даты» не переписывает прошлое: она заводит версию, а прошлые
 * недели остаются на прежней. Повторная правка той же даты заменяет
 * содержимое версии — это одна и та же правка, а не вторая.
 */
export interface RosterVersionRecord {
  id: string;
  effectiveFrom: BusinessDate;
  bedIds: string[];
}

export interface NormZoneRecord {
  areaId: string;
  checklistId: string;
  people: number;
}

export interface NormVersionRecord {
  id: string;
  effectiveFrom: BusinessDate;
  zones: NormZoneRecord[];
}

export async function listRowRosters(
  context: AccessContext,
  rowId: string,
  executor: Executor = getDb(),
): Promise<RosterVersionRecord[]> {
  await requireRotationRow(context, rowId, executor);

  const versions = await executor
    .select()
    .from(rotationRowRosters)
    .where(eq(rotationRowRosters.rowId, rowId))
    .orderBy(asc(rotationRowRosters.effectiveFrom), asc(rotationRowRosters.id));

  if (versions.length === 0) {
    return [];
  }

  const slots = await executor
    .select()
    .from(rotationRowRosterSlots)
    .where(
      inArray(
        rotationRowRosterSlots.rosterId,
        versions.map((version) => version.id),
      ),
    )
    .orderBy(asc(rotationRowRosterSlots.position), asc(rotationRowRosterSlots.id));

  return versions.map((version) => ({
    id: version.id,
    effectiveFrom: version.effectiveFrom as BusinessDate,
    bedIds: slots.filter((slot) => slot.rosterId === version.id).map((slot) => slot.bedId),
  }));
}

export async function replaceRowRoster(
  context: AccessContext,
  input: { rowId: string; effectiveFrom: BusinessDate; bedIds: readonly string[] },
  executor: Executor = getDb(),
): Promise<RosterVersionRecord> {
  await requireRotationRow(context, input.rowId, executor);

  const [existing] = await executor
    .select()
    .from(rotationRowRosters)
    .where(
      and(
        eq(rotationRowRosters.rowId, input.rowId),
        eq(rotationRowRosters.effectiveFrom, input.effectiveFrom),
      ),
    )
    .limit(1);

  let rosterId = existing?.id ?? '';

  if (existing === undefined) {
    const [created] = await executor
      .insert(rotationRowRosters)
      .values({ rowId: input.rowId, effectiveFrom: input.effectiveFrom })
      .returning();

    if (created === undefined) {
      throw new Error('Версия состава ряда не создана');
    }

    rosterId = created.id;
  } else {
    await executor
      .delete(rotationRowRosterSlots)
      .where(eq(rotationRowRosterSlots.rosterId, rosterId));
  }

  if (input.bedIds.length > 0) {
    await executor
      .insert(rotationRowRosterSlots)
      .values(input.bedIds.map((bedId, position) => ({ rosterId, position, bedId })));
  }

  return { id: rosterId, effectiveFrom: input.effectiveFrom, bedIds: [...input.bedIds] };
}

export async function listDayNorms(
  context: AccessContext,
  rowId: string,
  executor: Executor = getDb(),
): Promise<NormVersionRecord[]> {
  await requireRotationRow(context, rowId, executor);

  const versions = await executor
    .select()
    .from(rotationDayNorms)
    .where(eq(rotationDayNorms.rowId, rowId))
    .orderBy(asc(rotationDayNorms.effectiveFrom), asc(rotationDayNorms.id));

  if (versions.length === 0) {
    return [];
  }

  const zones = await executor
    .select()
    .from(rotationDayNormZones)
    .where(
      inArray(
        rotationDayNormZones.normId,
        versions.map((version) => version.id),
      ),
    )
    .orderBy(asc(rotationDayNormZones.position), asc(rotationDayNormZones.id));

  return versions.map((version) => ({
    id: version.id,
    effectiveFrom: version.effectiveFrom as BusinessDate,
    zones: zones
      .filter((zone) => zone.normId === version.id)
      .map((zone) => ({
        areaId: zone.areaId,
        checklistId: zone.checklistId,
        people: zone.people,
      })),
  }));
}

export async function replaceDayNorm(
  context: AccessContext,
  input: {
    rowId: string;
    effectiveFrom: BusinessDate;
    zones: readonly NormZoneRecord[];
  },
  executor: Executor = getDb(),
): Promise<NormVersionRecord> {
  await requireRotationRow(context, input.rowId, executor);

  const [existing] = await executor
    .select()
    .from(rotationDayNorms)
    .where(
      and(
        eq(rotationDayNorms.rowId, input.rowId),
        eq(rotationDayNorms.effectiveFrom, input.effectiveFrom),
      ),
    )
    .limit(1);

  let normId = existing?.id ?? '';

  if (existing === undefined) {
    const [created] = await executor
      .insert(rotationDayNorms)
      .values({ rowId: input.rowId, effectiveFrom: input.effectiveFrom })
      .returning();

    if (created === undefined) {
      throw new Error('Версия нормы дня не создана');
    }

    normId = created.id;
  } else {
    await executor.delete(rotationDayNormZones).where(eq(rotationDayNormZones.normId, normId));
  }

  if (input.zones.length > 0) {
    await executor.insert(rotationDayNormZones).values(
      input.zones.map((zone, position) => ({
        normId,
        position,
        areaId: zone.areaId,
        checklistId: zone.checklistId,
        people: zone.people,
      })),
    );
  }

  return { id: normId, effectiveFrom: input.effectiveFrom, zones: [...input.zones] };
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
    .orderBy(asc(rotationRowZones.position), asc(rotationRowZones.id));
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
  /** Сколько человек убирает зону в этот день; по умолчанию один. */
  peopleNeeded?: number;
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
      peopleNeeded: input.peopleNeeded ?? 1,
      movedFromDate: input.movedFromDate ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  if (occurrence === undefined) {
    throw new Error('Занятие не создано');
  }

  return occurrence;
}

/**
 * Снятие занятия вместе с его назначениями (план фазы 10, §2.6).
 *
 * Пересборка после правки «с даты» именно удаляет нетронутое занятие,
 * а не правит его на месте: у нового расклада может быть другое число
 * людей и другой набор зон, и подгонять старую строку под него значило бы
 * хранить занятие, которого никто не назначал.
 */
export async function deleteOccurrence(
  context: AccessContext,
  occurrenceId: string,
  executor: Executor = getDb(),
): Promise<void> {
  await requireOccurrence(context, occurrenceId, executor);

  await executor
    .delete(rotationAssignments)
    .where(eq(rotationAssignments.occurrenceId, occurrenceId));
  await executor.delete(rotationOccurrences).where(eq(rotationOccurrences.id, occurrenceId));
}

export async function listOccurrences(
  context: AccessContext,
  houseId: string,
  range: { from: BusinessDate; to: BusinessDate },
  executor: Executor = getDb(),
): Promise<RotationOccurrence[]> {
  assertHouseReadable(context, houseId);

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
    .orderBy(
      asc(rotationOccurrences.date),
      asc(rotationOccurrences.createdAt),
      asc(rotationOccurrences.id),
    );
}

/**
 * Кто занимает места дома на указанную дату.
 *
 * Период занятости полуоткрытый: день выезда место уже свободно (P2-1),
 * поэтому дата сравнивается включением в сам диапазон, а не с его границами.
 */
export async function listBedOccupantsOn(
  context: AccessContext,
  houseId: string,
  date: BusinessDate,
  executor: Executor = getDb(),
): Promise<{ bedId: string; userId: string }[]> {
  assertHouseVisible(context, houseId);

  const rows = await executor
    .select({ bedId: bedAssignments.bedId, userId: residencies.userId })
    .from(bedAssignments)
    .innerJoin(residencies, eq(residencies.id, bedAssignments.residencyId))
    .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
    .where(
      and(
        eq(beds.houseId, houseId),
        houseScope(context, beds.houseId),
        sql`${bedAssignments.period} @> ${date}::date`,
      ),
    );

  return rows;
}

export async function requireOccurrence(
  context: AccessContext,
  occurrenceId: string,
  executor: Executor = getDb(),
): Promise<RotationOccurrence> {
  const [occurrence] = await executor
    .select()
    .from(rotationOccurrences)
    .where(
      and(
        eq(rotationOccurrences.id, occurrenceId),
        eq(rotationOccurrences.orgId, context.orgId),
        houseScope(context, rotationOccurrences.houseId),
      ),
    )
    .limit(1);

  if (occurrence === undefined) {
    throw new NotFoundError('Занятие не найдено');
  }

  return occurrence;
}

export interface CreateAssignmentInput {
  occurrenceId: string;
  userId?: string | null;
  slotPosition?: number | null;
  source?: 'auto' | 'manual' | 'debt';
  state?: 'assigned' | 'needs_reassignment' | 'confirmed' | 'missed' | 'cancelled';
  /** Причина пустоты; без неё пустое назначение получает «некого назначить». */
  emptyReason?: RotationEmptyReason | null;
  /** Кто стоял в очереди на зону, но не допущен к ней (§2.5). */
  queuedUserId?: string | null;
  /** Галочка «списать доп. ротацию» (§2.7). */
  writeOffDebt?: boolean;
}

/**
 * Причина пустоты держится в паре с исполнителем, а не отдельно от него.
 *
 * База требует того же проверкой `rotation_assignments_empty_has_reason`,
 * и держать это правило в каждом сервисе значило бы рано или поздно
 * забыть его в одном: дырка без причины выпала бы из «Требует решения».
 */
function emptyReasonFor(
  userId: string | null,
  reason: RotationEmptyReason | null | undefined,
): RotationEmptyReason | null {
  if (userId !== null) {
    return null;
  }

  return reason ?? 'no_one';
}

export async function createAssignment(
  context: AccessContext,
  input: CreateAssignmentInput,
  executor: Executor = getDb(),
): Promise<RotationAssignment> {
  await requireOccurrence(context, input.occurrenceId, executor);

  const userId = input.userId ?? null;

  const [assignment] = await executor
    .insert(rotationAssignments)
    .values({
      occurrenceId: input.occurrenceId,
      userId,
      slotPosition: input.slotPosition ?? null,
      source: input.source ?? 'auto',
      state: input.state ?? 'assigned',
      emptyReason: emptyReasonFor(userId, input.emptyReason),
      queuedUserId: input.queuedUserId ?? null,
      writeOffDebt: input.writeOffDebt ?? false,
    })
    .returning();

  if (assignment === undefined) {
    throw new Error('Назначение не создано');
  }

  return assignment;
}

export interface UpdateAssignmentInput {
  userId?: string | null;
  /** Причина пустоты при снятии исполнителя; по умолчанию «некого назначить». */
  emptyReason?: RotationEmptyReason | null;
  queuedUserId?: string | null;
  writeOffDebt?: boolean;
  state?: 'assigned' | 'needs_reassignment' | 'confirmed' | 'missed' | 'cancelled';
  source?: 'auto' | 'manual' | 'debt';
  confirmedAt?: Date | null;
  confirmedBy?: string | null;
  doneAt?: Date | null;
  /** Оценка 1–10; проверка диапазона — в сервисе (§7). */
  score?: number | null;
  scoredBy?: string | null;
  scoredAt?: Date | null;
  photoFileIds?: string[];
  note?: string | null;
}

export async function updateAssignment(
  assignmentId: string,
  patch: UpdateAssignmentInput,
  executor: Executor = getDb(),
): Promise<RotationAssignment> {
  /*
   * Исполнитель и причина пустоты меняются вместе: назначили человека —
   * причина уходит, сняли — появляется. Иначе проверка базы отбила бы
   * правку, у которой снаружи всё в порядке.
   */
  const reasonPatch =
    patch.userId === undefined
      ? {}
      : { emptyReason: emptyReasonFor(patch.userId, patch.emptyReason) };

  const [assignment] = await executor
    .update(rotationAssignments)
    .set({ ...patch, ...reasonPatch, updatedAt: now() })
    .where(eq(rotationAssignments.id, assignmentId))
    .returning();

  if (assignment === undefined) {
    throw new NotFoundError('Назначение не найдено');
  }

  return assignment;
}

/**
 * Снятие назначения с занятия (план фазы 10 §2.6, «двор 2 → 1»).
 *
 * Строка книги долга, если она была, уходит вместе с ним: долг держится
 * ссылкой на назначение, а снимают только незакрытое — сервис не пускает
 * сюда подтверждённое и невыполненное.
 */
export async function deleteAssignment(
  assignmentId: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor.delete(rotationDebts).where(eq(rotationDebts.sourceAssignmentId, assignmentId));
  await executor.delete(rotationAssignments).where(eq(rotationAssignments.id, assignmentId));
}

/** Назначения перечисленных занятий: календарь читает их одним запросом. */
export async function listAssignmentsFor(
  occurrenceIds: readonly string[],
  executor: Executor = getDb(),
): Promise<RotationAssignment[]> {
  if (occurrenceIds.length === 0) {
    return [];
  }

  return executor
    .select()
    .from(rotationAssignments)
    .where(inArray(rotationAssignments.occurrenceId, [...occurrenceIds]))
    .orderBy(
      asc(rotationAssignments.slotPosition),
      asc(rotationAssignments.createdAt),
      asc(rotationAssignments.id),
    );
}

export interface UpdateOccurrenceInput {
  date?: BusinessDate;
  movedFromDate?: BusinessDate | null;
  status?: 'scheduled' | 'done' | 'missed' | 'cancelled';
  /** Число людей этого занятия; правка недели меняет его (§2.6). */
  peopleNeeded?: number;
}

export async function updateOccurrence(
  context: AccessContext,
  occurrenceId: string,
  patch: UpdateOccurrenceInput,
  executor: Executor = getDb(),
): Promise<RotationOccurrence> {
  await requireOccurrence(context, occurrenceId, executor);

  const [occurrence] = await executor
    .update(rotationOccurrences)
    .set({ ...patch, updatedAt: now() })
    .where(eq(rotationOccurrences.id, occurrenceId))
    .returning();

  if (occurrence === undefined) {
    throw new NotFoundError('Занятие не найдено');
  }

  return occurrence;
}

/** Назначения по их собственным идентификаторам. */
export async function listAssignmentsById(
  ids: readonly string[],
  executor: Executor = getDb(),
): Promise<RotationAssignment[]> {
  if (ids.length === 0) {
    return [];
  }

  return executor
    .select()
    .from(rotationAssignments)
    .where(inArray(rotationAssignments.id, [...ids]));
}

/**
 * Кто участвует в генеральной уборке дома (§6.5): жильцы и админ дома.
 *
 * Админа не селят, проживания у него нет, но убирает он наравне со всеми —
 * §6.5 называет его прямо. Берётся он из базы, а не из вызывающего: уборку
 * может запустить и суперадмин, а убирать будет всё равно админ дома.
 */
export async function listGeneralCleaningParticipants(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<string[]> {
  assertHouseReadable(context, houseId);

  const residents = await executor
    .select({ userId: residencies.userId })
    .from(residencies)
    .where(
      and(
        eq(residencies.houseId, houseId),
        houseScope(context, residencies.houseId),
        inArray(residencies.status, ['active', 'terminating']),
      ),
    );

  const admins = await executor
    .select({ userId: users.id })
    .from(users)
    .where(
      and(
        eq(users.orgId, context.orgId),
        eq(users.houseId, houseId),
        eq(users.role, 'admin'),
        eq(users.status, 'active'),
      ),
    );

  return Array.from(new Set([...residents, ...admins].map((row) => row.userId)));
}

/**
 * Занятия одной даты по всей сети: так их читает автозакрытие дня.
 *
 * Дома здесь не перебираются: заданию всё равно, в каком доме уборка,
 * а лишний обход по домам означал бы запрос на каждый дом сети.
 */
export async function listOccurrencesOfDate(
  context: AccessContext,
  date: BusinessDate,
  executor: Executor = getDb(),
): Promise<RotationOccurrence[]> {
  return executor
    .select()
    .from(rotationOccurrences)
    .where(
      and(
        eq(rotationOccurrences.orgId, context.orgId),
        eq(rotationOccurrences.date, date),
        houseScope(context, rotationOccurrences.houseId),
      ),
    )
    .orderBy(asc(rotationOccurrences.createdAt), asc(rotationOccurrences.id));
}

export interface CalendarDictionaries {
  areas: { id: string; name: string }[];
  checklists: { id: string; areaId: string; title: string; peopleNeeded: number }[];
  members: { userId: string; name: string }[];
}

/**
 * Справочники календаря: названия зон, чек-листов и жильцов дома.
 *
 * Живут здесь, а не в настройке дома, потому что календарь читает и жилец:
 * права на настройки у него нет, а имя убирающего он видеть должен.
 */
export async function listCalendarDictionaries(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<CalendarDictionaries> {
  assertHouseReadable(context, houseId);

  const areaRows = await executor
    .select({ id: areas.id, name: areas.name })
    .from(areas)
    .where(and(eq(areas.houseId, houseId), houseScope(context, areas.houseId)))
    .orderBy(asc(areas.sortOrder), asc(areas.name), asc(areas.id));

  const checklistRows = await executor
    .select({
      id: areaChecklists.id,
      areaId: areaChecklists.areaId,
      title: areaChecklists.title,
      peopleNeeded: areaChecklists.peopleNeeded,
    })
    .from(areaChecklists)
    .innerJoin(areas, eq(areas.id, areaChecklists.areaId))
    .where(
      and(
        eq(areas.houseId, houseId),
        houseScope(context, areas.houseId),
        isNull(areaChecklists.archivedAt),
      ),
    );

  const memberRows = await executor
    .select({
      userId: residencies.userId,
      lastName: residentProfiles.lastName,
      firstName: residentProfiles.firstName,
      phone: users.phone,
    })
    .from(residencies)
    .leftJoin(residentProfiles, eq(residentProfiles.userId, residencies.userId))
    .innerJoin(users, eq(users.id, residencies.userId))
    .where(
      and(
        eq(residencies.houseId, houseId),
        // Жилец получает имена соседей только своего дома: та же связь
        // через проживание, что и у остального его чтения.
        houseScope(context, residencies.houseId),
        inArray(residencies.status, ['active', 'terminating']),
      ),
    )
    .orderBy(
      asc(residentProfiles.lastName),
      asc(residentProfiles.firstName),
      asc(users.phone),
      asc(users.id),
    );

  return {
    areas: areaRows,
    checklists: checklistRows,
    members: memberRows.map((row) => {
      const name = [row.lastName, row.firstName]
        .filter((part) => part !== null)
        .join(' ')
        .trim();

      return { userId: row.userId, name: name === '' ? row.phone : name };
    }),
  };
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
  // Шапку читает и жилец: текст дня показывается в календаре, который
  // ему положен. Дом при этом проверяет `houseScope`, а не контекст.
  assertHouseReadable(context, houseId);

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
