import { getDb, type Executor } from '@/db/client';
import {
  createArea,
  createBed,
  listAreas,
  listBeds,
  requireArea,
  requireBed,
  updateArea,
  updateBed,
} from '@/db/repositories/areas';
import { requireHouse } from '@/db/repositories/houses';
import { findOpenAssignmentOfBed, listOccupiedBedIds } from '@/db/repositories/residencies';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { now } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { Area, Bed } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Настройка дома: зоны, места и цены по умолчанию
 * (docs/04-MODULES/02-places-and-payments.md, «Настройка дома»;
 * docs/04-MODULES/11-users-settings.md, «Настройки дома»).
 *
 * Зона и место не удаляются, а архивируются: на них ссылаются назначения
 * и история занятости. Занятое место и непустая зона из настройки не уходят —
 * иначе жилец оказался бы в комнате, которой в схеме больше нет.
 */
export interface HouseSetupDeps {
  executor?: Executor;
}

export interface AreaInput {
  name: string;
  type: Area['type'];
  sortOrder?: number;
}

export interface AreaPatch {
  name?: string;
  sortOrder?: number;
}

export interface BedInput {
  /** Обозначение места глазами админа: «1 верх», «у окна». */
  label: string;
  number: number;
  tier: Bed['tier'];
  defaultPrice: number;
}

export type BedPatch = Partial<BedInput>;

export interface BedSetupView {
  bed: Bed;
  /** Место занято сейчас: архивировать его нельзя. */
  occupied: boolean;
}

export interface AreaSetupView {
  area: Area;
  beds: BedSetupView[];
}

export interface HouseSetupView {
  houseId: string;
  houseName: string;
  /** Депозит дома (§1.2 п.7). Правит его суперадмин в настройках сети. */
  depositDefault: number;
  areas: AreaSetupView[];
}

function executorOf(deps: HouseSetupDeps): Executor {
  return deps.executor ?? getDb();
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new ValidationError('houseSetup.errors.nameRequired');
  }

  return trimmed;
}

function assertPrice(price: number): void {
  // Деньги — целые тенге (D9): дробная цена места невозможна по правилу §0.
  if (!Number.isSafeInteger(price) || price < 0) {
    throw new ValidationError('houseSetup.errors.priceInvalid');
  }
}

function assertNumber(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError('houseSetup.errors.numberInvalid');
  }
}

/**
 * Уникальность `(area_id, number, tier)` держит база (`02-DATA-MODEL.md`).
 * Здесь её нарушение переводится в конфликт: двухъярусная кровать — это
 * тот же номер на другом ярусе, а не второе место на том же.
 */
function isUniqueViolation(error: unknown): boolean {
  // Драйвер оборачивает ошибку запроса своей, поэтому код ищется и в причине.
  for (let current = error; current !== null && current !== undefined;) {
    if (typeof current === 'object' && 'code' in current) {
      if ((current as { code?: unknown }).code === '23505') {
        return true;
      }
    }

    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }

  return false;
}

export async function readHouseSetup(
  actor: UserActor,
  houseId: string,
  deps: HouseSetupDeps = {},
): Promise<HouseSetupView> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.read', { houseId });

  const [house, areas, beds, occupied] = await Promise.all([
    requireHouse(actor.context, houseId, executor),
    listAreas(actor.context, houseId, {}, executor),
    listBeds(actor.context, houseId, {}, executor),
    listOccupiedBedIds(houseId, executor),
  ]);

  const taken = new Set(occupied);

  return {
    houseId: house.id,
    houseName: house.name,
    depositDefault: house.defaultDeposit,
    areas: areas.map((area) => ({
      area,
      beds: beds
        .filter((bed) => bed.areaId === area.id)
        .map((bed) => ({ bed, occupied: taken.has(bed.id) })),
    })),
  };
}

export async function createHouseArea(
  actor: UserActor,
  houseId: string,
  input: AreaInput,
  deps: HouseSetupDeps = {},
): Promise<Area> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.write', { houseId });
  const name = assertName(input.name);

  return executor.transaction(async (tx) => {
    const area = await createArea(
      actor.context,
      {
        houseId,
        name,
        type: input.type,
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.areaCreated,
        entityType: 'area',
        entityId: area.id,
        after: { houseId, name: area.name, type: area.type, sortOrder: area.sortOrder },
      },
      tx,
    );

    return area;
  });
}

export async function updateHouseArea(
  actor: UserActor,
  areaId: string,
  patch: AreaPatch,
  deps: HouseSetupDeps = {},
): Promise<Area> {
  const executor = executorOf(deps);

  const before = await requireArea(actor.context, areaId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: before.houseId });

  const name = patch.name === undefined ? undefined : assertName(patch.name);

  return executor.transaction(async (tx) => {
    const updated = await updateArea(
      actor.context,
      areaId,
      {
        ...(name === undefined ? {} : { name }),
        ...(patch.sortOrder === undefined ? {} : { sortOrder: patch.sortOrder }),
      },
      tx,
    );

    if (updated === null) {
      throw new NotFoundError('Зона не найдена');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.areaUpdated,
        entityType: 'area',
        entityId: areaId,
        before: { name: before.name, sortOrder: before.sortOrder },
        after: { name: updated.name, sortOrder: updated.sortOrder },
      },
      tx,
    );

    return updated;
  });
}

/** Зона архивируется пустой: сначала места, иначе они остались бы в никуда. */
export async function archiveHouseArea(
  actor: UserActor,
  areaId: string,
  deps: HouseSetupDeps = {},
): Promise<Area> {
  const executor = executorOf(deps);

  const before = await requireArea(actor.context, areaId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: before.houseId });

  const beds = await listBeds(actor.context, before.houseId, { areaId }, executor);
  if (beds.length > 0) {
    throw new ConflictError('houseSetup.errors.areaHasBeds');
  }

  const archivedAt = now();

  return executor.transaction(async (tx) => {
    const updated = await updateArea(actor.context, areaId, { archivedAt }, tx);
    if (updated === null) {
      throw new NotFoundError('Зона не найдена');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.areaArchived,
        entityType: 'area',
        entityId: areaId,
        before: { archivedAt: before.archivedAt },
        after: { archivedAt },
      },
      tx,
    );

    return updated;
  });
}

export async function createHouseBed(
  actor: UserActor,
  areaId: string,
  input: BedInput,
  deps: HouseSetupDeps = {},
): Promise<Bed> {
  const executor = executorOf(deps);

  const area = await requireArea(actor.context, areaId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: area.houseId });

  // Место существует только в жилой комнате: в общей зоне спать негде.
  if (area.type !== 'living') {
    throw new ValidationError('houseSetup.errors.notLivingArea');
  }

  const label = assertName(input.label);
  assertNumber(input.number);
  assertPrice(input.defaultPrice);

  try {
    return await executor.transaction(async (tx) => {
      const bed = await createBed(
        actor.context,
        {
          houseId: area.houseId,
          areaId,
          label,
          number: input.number,
          tier: input.tier,
          defaultPrice: input.defaultPrice,
        },
        tx,
      );

      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.bedCreated,
          entityType: 'bed',
          entityId: bed.id,
          after: {
            areaId,
            label: bed.label,
            number: bed.number,
            tier: bed.tier,
            defaultPrice: bed.defaultPrice,
          },
        },
        tx,
      );

      return bed;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('houseSetup.errors.bedDuplicate');
    }

    throw error;
  }
}

export async function updateHouseBed(
  actor: UserActor,
  bedId: string,
  patch: BedPatch,
  deps: HouseSetupDeps = {},
): Promise<Bed> {
  const executor = executorOf(deps);

  const before = await requireBed(actor.context, bedId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: before.houseId });

  const label = patch.label === undefined ? undefined : assertName(patch.label);
  if (patch.number !== undefined) {
    assertNumber(patch.number);
  }
  if (patch.defaultPrice !== undefined) {
    assertPrice(patch.defaultPrice);
  }

  try {
    return await executor.transaction(async (tx) => {
      const updated = await updateBed(
        actor.context,
        bedId,
        {
          ...(label === undefined ? {} : { label }),
          ...(patch.number === undefined ? {} : { number: patch.number }),
          ...(patch.tier === undefined ? {} : { tier: patch.tier }),
          ...(patch.defaultPrice === undefined ? {} : { defaultPrice: patch.defaultPrice }),
        },
        tx,
      );

      if (updated === null) {
        throw new NotFoundError('Место не найдено');
      }

      /*
       * Цена по умолчанию — цена нового назначения. Уже назначенное место
       * сохраняет свою цену: она индивидуальна (льгота, админ — 0) и живёт
       * в назначении, а не в месте (модуль 2).
       */
      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.bedUpdated,
          entityType: 'bed',
          entityId: bedId,
          before: {
            label: before.label,
            number: before.number,
            tier: before.tier,
            defaultPrice: before.defaultPrice,
          },
          after: {
            label: updated.label,
            number: updated.number,
            tier: updated.tier,
            defaultPrice: updated.defaultPrice,
          },
        },
        tx,
      );

      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('houseSetup.errors.bedDuplicate');
    }

    throw error;
  }
}

export async function archiveHouseBed(
  actor: UserActor,
  bedId: string,
  deps: HouseSetupDeps = {},
): Promise<Bed> {
  const executor = executorOf(deps);

  const before = await requireBed(actor.context, bedId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: before.houseId });

  const assignment = await findOpenAssignmentOfBed(bedId, executor);
  if (assignment !== null) {
    throw new ConflictError('houseSetup.errors.bedOccupied');
  }

  const archivedAt = now();

  return executor.transaction(async (tx) => {
    const updated = await updateBed(actor.context, bedId, { archivedAt }, tx);
    if (updated === null) {
      throw new NotFoundError('Место не найдено');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.bedArchived,
        entityType: 'bed',
        entityId: bedId,
        before: { archivedAt: before.archivedAt },
        after: { archivedAt },
      },
      tx,
    );

    return updated;
  });
}
