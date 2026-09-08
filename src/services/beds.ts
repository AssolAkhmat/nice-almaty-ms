import { getDb, type Executor } from '@/db/client';
import { findPlacementOfResidency, listAreas, listBeds, requireBed } from '@/db/repositories/areas';
import {
  assignBed,
  findOpenAssignment,
  listResidencies,
  releaseBed,
  requireResidency,
} from '@/db/repositories/residencies';
import { assertCan } from '@/lib/authz';
import { ValidationError } from '@/lib/errors';
import { todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { syncFutureAssignments } from './rotation-schedule';

import type { Area, BedAssignment } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Назначение места и цены (docs/04-MODULES/01-onboarding.md, §1.2 п.4).
 *
 * Смена места закрывает прежнее назначение той же датой и открывает новое:
 * история занятости сохраняется, а пересечься периодам всё равно не даст
 * ограничение исключения в базе (инвариант 1 из `02-DATA-MODEL.md`).
 */
export interface BedDeps {
  executor?: Executor;
  today?: BusinessDate;
}

function resolve(deps: BedDeps): { executor: Executor; today: BusinessDate } {
  return { executor: deps.executor ?? getDb(), today: deps.today ?? todayInAlmaty() };
}

export interface AssignBedInput {
  residencyId: string;
  bedId: string;
  /** Пусто — цена места по умолчанию; она же редактируется индивидуально. */
  price?: number | undefined;
  /** Пусто — сегодня. */
  from?: BusinessDate | undefined;
}

/** Место в схеме дома: кто на нём живёт сейчас и по какой цене. */
export interface BedSlotView {
  bedId: string;
  label: string;
  tier: 'upper' | 'lower';
  number: number;
  defaultPrice: number;
  occupiedBy: { residencyId: string; userId: string; price: number } | null;
}

export interface AreaLayoutView {
  area: Area;
  beds: BedSlotView[];
}

export async function assignBedToResidency(
  actor: UserActor,
  input: AssignBedInput,
  deps: BedDeps = {},
): Promise<BedAssignment> {
  const { executor, today } = resolve(deps);

  const residency = await requireResidency(actor.context, input.residencyId, executor);
  assertCan(actor.context, 'bed.assign', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  const bed = await requireBed(actor.context, input.bedId, executor);

  if (bed.houseId !== residency.houseId) {
    // Место другого дома — не «другое место», а другое проживание.
    throw new ValidationError('beds.bedFromAnotherHouse');
  }

  const price = input.price ?? bed.defaultPrice;
  if (!Number.isInteger(price) || price < 0) {
    throw new ValidationError('beds.priceInvalid');
  }

  const from = input.from ?? today;
  const previous = await findOpenAssignment(residency.id, executor);

  return executor.transaction(async (tx) => {
    const assignment = await assignBed(
      { residencyId: residency.id, bedId: bed.id, price, from, createdBy: actor.context.userId },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.bedAssigned,
        entityType: 'residency',
        entityId: residency.id,
        before: previous === null ? undefined : { bedId: previous.bedId, price: previous.price },
        after: { bedId: bed.id, price, from },
      },
      tx,
    );

    /*
     * Будущие ротации пересчитываются сразу (§6.6): слот ряда держится места,
     * и сменившийся жилец обязан появиться в расписании вместе с заселением.
     * Иначе за место убирал бы съехавший — до следующей ручной генерации.
     */
    await syncFutureAssignments(actor, residency.houseId, today, { executor: tx, today });

    return assignment;
  });
}

/** Освобождение места: история назначения остаётся, период закрывается датой. */
export async function releaseBedOfResidency(
  actor: UserActor,
  residencyId: string,
  on: BusinessDate,
  deps: BedDeps = {},
): Promise<void> {
  const { executor } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'bed.assign', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  const open = await findOpenAssignment(residency.id, executor);
  if (open === null) {
    return;
  }

  await executor.transaction(async (tx) => {
    await releaseBed(residency.id, on, tx);

    // Освободившееся место возвращает свои будущие назначения в «требует
    // решения»: убирать за него теперь некому, и это видно админу (§6.3).
    await syncFutureAssignments(actor, residency.houseId, on, { executor: tx, today: on });

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.bedReleased,
        entityType: 'residency',
        entityId: residency.id,
        before: { bedId: open.bedId },
        after: { releasedOn: on },
      },
      tx,
    );
  });
}

/**
 * Схема дома: комнаты и занятость мест. Занятость собирается по действующим
 * назначениям видимых проживаний — второй копии правила видимости нет (P2-5).
 */
export async function houseLayout(
  actor: UserActor,
  houseId: string,
  deps: BedDeps = {},
): Promise<AreaLayoutView[]> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'bed.read', { houseId });

  const [areas, beds, residencies] = await Promise.all([
    listAreas(actor.context, houseId, {}, executor),
    listBeds(actor.context, houseId, {}, executor),
    listResidencies(actor.context, { houseId }, executor),
  ]);

  const occupancy = new Map<string, { residencyId: string; userId: string; price: number }>();

  for (const residency of residencies) {
    const assignment = await findOpenAssignment(residency.id, executor);
    if (assignment !== null) {
      occupancy.set(assignment.bedId, {
        residencyId: residency.id,
        userId: residency.userId,
        price: assignment.price,
      });
    }
  }

  /*
   * Только жилые комнаты: места бывают лишь в них, а общая зона на схеме
   * «занято 0 из 0» ничего не сообщает и только удлиняет список (T9.9).
   * Зоны с чек-листами живут в настройке дома и в ротациях.
   */
  return areas
    .filter((area) => area.type === 'living')
    .map((area) => ({
      area,
      beds: beds
        .filter((bed) => bed.areaId === area.id)
        .map((bed) => ({
          bedId: bed.id,
          label: bed.label,
          tier: bed.tier,
          number: bed.number,
          defaultPrice: bed.defaultPrice,
          occupiedBy: occupancy.get(bed.id) ?? null,
        })),
    }));
}

/** Место жильца: для него самого — единственная видимая часть схемы. */
export async function myPlacement(actor: UserActor, residencyId: string, deps: BedDeps = {}) {
  const { executor } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'bed.read', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  return findPlacementOfResidency(actor.context, residency.id, executor);
}
