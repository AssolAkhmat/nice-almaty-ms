import { getDb, type Executor } from '@/db/client';
import { listAreas, listBeds } from '@/db/repositories/areas';
import {
  listBedOccupantsOn,
  listChecklists,
  listDayNorms,
  listRotationRows,
  listRowRosters,
  replaceDayNorm,
  replaceRowRoster,
  requireRotationRow,
} from '@/db/repositories/rotations';
import { dayPlan, type EmptySlotReason, type PlannedAssignment } from '@/domain/rotation-day';
import { assertCan } from '@/lib/authz';
import { ValidationError } from '@/lib/errors';
import {
  addDays,
  compareBusinessDates,
  parseBusinessDate,
  startOfDayUtc,
  toAlmatyParts,
  type BusinessDate,
} from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { RotationRow } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Настройка дня ротаций (план фазы 10, §2.2, §2.3, §5).
 *
 * Ряд дня отвечает на вопрос «кто участвует», норма дня — «какие зоны
 * убираются и сколько человек на каждую». Обе сущности версионируются датой
 * вступления: правка «с 21 октября» заводит версию, прошлые недели остаются
 * на прежней, а счётчик недель `k` не сбивается (P10-5).
 *
 * Раскладка не считается здесь: она вся в `src/domain/rotation-day.ts`,
 * а сервис только приносит ядру состав, норму и жильцов мест на дату.
 */

export interface RotationDaySetupDeps {
  executor?: Executor;
}

function executorOf(deps: RotationDaySetupDeps): Executor {
  return deps.executor ?? getDb();
}

/** Сколько недель показывает предпросмотр по умолчанию (§5). */
const PREVIEW_WEEKS = 4;
const DAYS_IN_WEEK = 7;

export interface RosterVersionView {
  id: string;
  effectiveFrom: BusinessDate;
  bedIds: string[];
}

export interface NormZoneView {
  areaId: string;
  checklistId: string;
  people: number;
}

export interface NormVersionView {
  id: string;
  effectiveFrom: BusinessDate;
  zones: NormZoneView[];
}

export interface RowDaySetupView {
  row: RotationRow;
  /** Версии по возрастанию даты вступления: последняя — действующая. */
  rosters: RosterVersionView[];
  norms: NormVersionView[];
}

export interface DaySetupView {
  houseId: string;
  rows: RowDaySetupView[];
  /** Места дома, не попавшие ни в один состав: подсказка «места вне рядов» (§5). */
  bedsOutsideRows: string[];
  /**
   * Места, стоящие в составах нескольких рядов. Это предупреждение, а не запрет:
   * базово каждый убирает раз в неделю, но админ вправе решить иначе (умолчание 4).
   */
  bedsInSeveralRows: { bedId: string; rowIds: string[] }[];
}

export async function readDaySetup(
  actor: UserActor,
  houseId: string,
  deps: RotationDaySetupDeps = {},
): Promise<DaySetupView> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.read', { houseId });

  const [rows, beds] = await Promise.all([
    listRotationRows(actor.context, houseId, {}, executor),
    listBeds(actor.context, houseId, {}, executor),
  ]);

  const views: RowDaySetupView[] = [];

  for (const row of rows) {
    const [rosters, norms] = await Promise.all([
      listRowRosters(actor.context, row.id, executor),
      listDayNorms(actor.context, row.id, executor),
    ]);

    views.push({ row, rosters, norms });
  }

  /** Место -> ряды, в чьих составах оно стоит хоть в одной версии. */
  const rowsByBed = new Map<string, string[]>();

  for (const view of views) {
    const bedIds = new Set(view.rosters.flatMap((version) => version.bedIds));

    for (const bedId of bedIds) {
      rowsByBed.set(bedId, [...(rowsByBed.get(bedId) ?? []), view.row.id]);
    }
  }

  return {
    houseId,
    rows: views,
    bedsOutsideRows: beds.filter((bed) => !rowsByBed.has(bed.id)).map((bed) => bed.id),
    bedsInSeveralRows: beds
      .filter((bed) => (rowsByBed.get(bed.id)?.length ?? 0) > 1)
      .map((bed) => ({ bedId: bed.id, rowIds: rowsByBed.get(bed.id) ?? [] })),
  };
}

/** День недели даты по календарю Алматы: 0 — воскресенье, 6 — суббота. */
function weekdayOf(date: BusinessDate): number {
  return toAlmatyParts(startOfDayUtc(date)).weekday;
}

/**
 * Версия не может вступить раньше старта ряда: до старта сетки нет,
 * и номер недели для такой даты не определён.
 */
function assertEffectiveFrom(row: RotationRow, value: BusinessDate): BusinessDate {
  const effectiveFrom = parseBusinessDate(value);

  if (compareBusinessDates(effectiveFrom, row.startDate as BusinessDate) < 0) {
    throw new ValidationError('rotationDaySetup.errors.effectiveBeforeStart');
  }

  return effectiveFrom;
}

export interface SaveRosterInput {
  rowId: string;
  effectiveFrom: BusinessDate;
  /** Порядок списка и есть порядок позиций в цикле. */
  bedIds: readonly string[];
}

export async function saveRoster(
  actor: UserActor,
  input: SaveRosterInput,
  deps: RotationDaySetupDeps = {},
): Promise<RosterVersionView> {
  const executor = executorOf(deps);

  const row = await requireRotationRow(actor.context, input.rowId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: row.houseId });

  const effectiveFrom = assertEffectiveFrom(row, input.effectiveFrom);

  if (input.bedIds.length === 0) {
    throw new ValidationError('rotationDaySetup.errors.rosterEmpty');
  }

  if (new Set(input.bedIds).size !== input.bedIds.length) {
    throw new ValidationError('rotationDaySetup.errors.bedTwice');
  }

  const beds = await listBeds(actor.context, row.houseId, {}, executor);
  const byId = new Map(beds.map((bed) => [bed.id, bed]));

  for (const bedId of input.bedIds) {
    const bed = byId.get(bedId);

    if (bed === undefined) {
      throw new ValidationError('rotationDaySetup.errors.bedOtherHouse');
    }

    // Комнатный ряд ходит по кругу внутри своей комнаты (§6.4): чужое место
    // дало бы жильцу уборку комнаты, в которой он не живёт.
    if (row.type === 'room' && bed.areaId !== row.roomAreaId) {
      throw new ValidationError('rotationDaySetup.errors.roomRosterBeds');
    }
  }

  return executor.transaction(async (tx) => {
    const previous = await listRowRosters(actor.context, row.id, tx);
    const before = previous.find((version) => version.effectiveFrom === effectiveFrom);

    const saved = await replaceRowRoster(
      actor.context,
      { rowId: row.id, effectiveFrom, bedIds: input.bedIds },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationRosterSaved,
        entityType: 'rotation_row',
        entityId: row.id,
        before: before === undefined ? undefined : { effectiveFrom, beds: before.bedIds.length },
        after: { effectiveFrom, beds: saved.bedIds.length },
      },
      tx,
    );

    return saved;
  });
}

export interface SaveNormZoneInput {
  areaId: string;
  checklistId: string;
  /** Сколько человек убирает зону в этот день; по умолчанию — из чек-листа. */
  people?: number;
}

export interface SaveNormInput {
  rowId: string;
  effectiveFrom: BusinessDate;
  zones: readonly SaveNormZoneInput[];
}

export async function saveNorm(
  actor: UserActor,
  input: SaveNormInput,
  deps: RotationDaySetupDeps = {},
): Promise<NormVersionView> {
  const executor = executorOf(deps);

  const row = await requireRotationRow(actor.context, input.rowId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: row.houseId });

  const effectiveFrom = assertEffectiveFrom(row, input.effectiveFrom);

  if (input.zones.length === 0) {
    throw new ValidationError('rotationDaySetup.errors.normEmpty');
  }

  // Комнатный ряд убирает одну зону — саму комнату (§6.4), и в ней один человек.
  if (
    row.type === 'room' &&
    (input.zones.length !== 1 || input.zones[0]?.areaId !== row.roomAreaId)
  ) {
    throw new ValidationError('rotationDaySetup.errors.roomNormSingleZone');
  }

  const [areas, checklists] = await Promise.all([
    listAreas(actor.context, row.houseId, {}, executor),
    listChecklists(actor.context, row.houseId, {}, executor),
  ]);

  const areaIds = new Set(areas.map((area) => area.id));
  const checklistById = new Map(checklists.map((checklist) => [checklist.id, checklist]));
  const seen = new Set<string>();

  const zones: NormZoneView[] = input.zones.map((zone) => {
    if (!areaIds.has(zone.areaId)) {
      throw new ValidationError('rotationDaySetup.errors.areaOtherHouse');
    }

    const checklist = checklistById.get(zone.checklistId);

    // Чек-лист чужой зоны означал бы, что убирают одно, а спрашивают другое.
    if (checklist === undefined || checklist.areaId !== zone.areaId) {
      throw new ValidationError('rotationDaySetup.errors.checklistArea');
    }

    const key = `${zone.areaId}|${zone.checklistId}`;

    if (seen.has(key)) {
      throw new ValidationError('rotationDaySetup.errors.zoneTwice');
    }

    seen.add(key);

    const people = zone.people ?? checklist.peopleNeeded;

    if (!Number.isInteger(people) || people < 1) {
      throw new ValidationError('rotationDaySetup.errors.peopleInvalid');
    }

    return { areaId: zone.areaId, checklistId: zone.checklistId, people };
  });

  return executor.transaction(async (tx) => {
    const previous = await listDayNorms(actor.context, row.id, tx);
    const before = previous.find((version) => version.effectiveFrom === effectiveFrom);

    const saved = await replaceDayNorm(actor.context, { rowId: row.id, effectiveFrom, zones }, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationNormSaved,
        entityType: 'rotation_row',
        entityId: row.id,
        before: before === undefined ? undefined : { effectiveFrom, zones: before.zones.length },
        after: { effectiveFrom, zones: saved.zones.length },
      },
      tx,
    );

    return saved;
  });
}

export interface PreviewDayAssignment {
  areaId: string;
  checklistId: string;
  position: number | null;
  bedId: string | null;
  userId: string | null;
  emptyReason: EmptySlotReason | null;
}

export interface PreviewDay {
  date: BusinessDate;
  week: number;
  assignments: PreviewDayAssignment[];
  resting: { position: number; bedId: string; userId: string | null }[];
}

export interface PreviewInput {
  rowId: string;
  /** С какой даты показывать: берутся ближайшие дни недели ряда, начиная с неё. */
  from: BusinessDate;
  weeks?: number;
  /** Черновик состава: предпросмотр показывает правку до сохранения (§5). */
  draftRoster?: { effectiveFrom: BusinessDate; bedIds: readonly string[] };
  draftNorm?: { effectiveFrom: BusinessDate; zones: readonly SaveNormZoneInput[] };
}

function toDuty(assignment: PlannedAssignment): PreviewDayAssignment {
  return {
    areaId: assignment.areaId,
    checklistId: assignment.checklistId,
    position: assignment.position,
    bedId: assignment.bedId,
    userId: assignment.userId,
    emptyReason: assignment.emptyReason,
  };
}

/**
 * Предпросмотр на несколько недель вперёд (§5).
 *
 * Считает ту же формулу, что и материализация, и по тем же данным: состав,
 * норма и жилец места на дату. Отсутствия и группы допуска в него не входят —
 * это предпросмотр сетки, а не расписания конкретной недели: одобренный отъезд
 * на третью неделю не должен выглядеть свойством ряда.
 */
export async function previewRotationDays(
  actor: UserActor,
  input: PreviewInput,
  deps: RotationDaySetupDeps = {},
): Promise<PreviewDay[]> {
  const executor = executorOf(deps);

  const row = await requireRotationRow(actor.context, input.rowId, executor);
  assertCan(actor.context, 'settings.house.read', { houseId: row.houseId });

  const [savedRosters, savedNorms, checklists] = await Promise.all([
    listRowRosters(actor.context, row.id, executor),
    listDayNorms(actor.context, row.id, executor),
    listChecklists(actor.context, row.houseId, {}, executor),
  ]);

  const peopleOf = new Map(checklists.map((checklist) => [checklist.id, checklist.peopleNeeded]));

  const rosters = [
    ...savedRosters.map((version) => ({
      effectiveFrom: version.effectiveFrom,
      bedIds: version.bedIds,
    })),
    ...(input.draftRoster === undefined
      ? []
      : [
          { effectiveFrom: input.draftRoster.effectiveFrom, bedIds: [...input.draftRoster.bedIds] },
        ]),
  ];

  const norms = [
    ...savedNorms.map((version) => ({
      effectiveFrom: version.effectiveFrom,
      zones: version.zones,
    })),
    ...(input.draftNorm === undefined
      ? []
      : [
          {
            effectiveFrom: input.draftNorm.effectiveFrom,
            zones: input.draftNorm.zones.map((zone) => ({
              areaId: zone.areaId,
              checklistId: zone.checklistId,
              people: zone.people ?? peopleOf.get(zone.checklistId) ?? 1,
            })),
          },
        ]),
  ];

  // Черновик кладётся последним и на равной дате побеждает сохранённую версию:
  // человек смотрит на то, что сейчас в форме, а не на то, что лежит в базе.
  if (rosters.length === 0 || norms.length === 0) {
    return [];
  }

  const start = parseBusinessDate(input.from);
  const weeks = input.weeks ?? PREVIEW_WEEKS;
  const rowStart = row.startDate as BusinessDate;

  let first = compareBusinessDates(start, rowStart) < 0 ? rowStart : start;

  while (weekdayOf(first) !== row.weekday) {
    first = addDays(first, 1);
  }

  const days: PreviewDay[] = [];

  for (let index = 0; index < weeks; index += 1) {
    const date = addDays(first, index * DAYS_IN_WEEK);
    const occupants = Object.fromEntries(
      (await listBedOccupantsOn(actor.context, row.houseId, date, executor)).map((occupant) => [
        occupant.bedId,
        occupant.userId,
      ]),
    );

    const plan = dayPlan({ rowStartDate: rowStart, date, rosters, norms, occupants });

    days.push({
      date,
      week: plan.week,
      assignments: plan.assignments.map(toDuty),
      resting: plan.resting,
    });
  }

  return days;
}
