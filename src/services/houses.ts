import { getDb, type Executor } from '@/db/client';
import {
  createHouse as insertHouse,
  listHouses,
  requireHouse,
  updateHouse as patchHouse,
} from '@/db/repositories/houses';
import { uniqueSlug } from '@/domain/slug';
import { assertCan } from '@/lib/authz';
import { ValidationError } from '@/lib/errors';
import { now } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { House } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Дома (docs/04-MODULES/11-users-settings.md, «Настройки сети»).
 * Заводит и архивирует только суперадмин; админ свой дом видит, но не меняет.
 */
const CURFEW_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface HouseInput {
  name: string;
  address?: string | null;
  /** `HH:MM`, по умолчанию 23:00. */
  curfewTime?: string;
  /** Целое число тенге. */
  defaultDeposit?: number;
}

function assertValid(input: HouseInput): void {
  if (input.name.trim() === '') {
    throw new ValidationError('Название дома обязательно');
  }

  if (input.curfewTime !== undefined && !CURFEW_PATTERN.test(input.curfewTime)) {
    throw new ValidationError('Комендантский час задаётся как ЧЧ:ММ');
  }

  if (input.defaultDeposit !== undefined) {
    // Деньги — целые тенге, тиынов нет (docs/03-BUSINESS-RULES.md §0).
    if (!Number.isSafeInteger(input.defaultDeposit) || input.defaultDeposit < 0) {
      throw new ValidationError('Депозит — целое неотрицательное число тенге');
    }
  }
}

export async function listHousesForActor(
  actor: UserActor,
  executor: Executor = getDb(),
): Promise<House[]> {
  return listHouses(actor.context, { includeArchived: true }, executor);
}

export async function createHouse(
  actor: UserActor,
  input: HouseInput,
  executor: Executor = getDb(),
): Promise<House> {
  assertCan(actor.context, 'house.create');
  assertValid(input);

  // Слаг выводится из названия: руками его вводить незачем, а путь хранения
  // документов без него не собрать.
  const existing = await listHouses(actor.context, { includeArchived: true }, executor);
  const slug = uniqueSlug(input.name, new Set(existing.map((house) => house.slug)));

  return executor.transaction(async (tx) => {
    const house = await insertHouse(
      actor.context,
      {
        name: input.name.trim(),
        slug,
        address: input.address ?? null,
        ...(input.curfewTime === undefined ? {} : { curfewTime: input.curfewTime }),
        ...(input.defaultDeposit === undefined ? {} : { defaultDeposit: input.defaultDeposit }),
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.houseCreated,
        entityType: 'house',
        entityId: house.id,
        after: { name: house.name, slug: house.slug },
      },
      tx,
    );

    return house;
  });
}

export async function updateHouse(
  actor: UserActor,
  houseId: string,
  input: HouseInput,
  executor: Executor = getDb(),
): Promise<House> {
  const before = await requireHouse(actor.context, houseId, executor);

  assertCan(actor.context, 'house.update', { houseId });
  assertValid(input);

  return executor.transaction(async (tx) => {
    const updated = await patchHouse(
      actor.context,
      houseId,
      {
        name: input.name.trim(),
        address: input.address ?? null,
        ...(input.curfewTime === undefined ? {} : { curfewTime: input.curfewTime }),
        ...(input.defaultDeposit === undefined ? {} : { defaultDeposit: input.defaultDeposit }),
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.houseUpdated,
        entityType: 'house',
        entityId: houseId,
        before: {
          name: before.name,
          address: before.address,
          curfewTime: before.curfewTime,
          defaultDeposit: before.defaultDeposit,
        },
        after: {
          name: updated?.name,
          address: updated?.address,
          curfewTime: updated?.curfewTime,
          defaultDeposit: updated?.defaultDeposit,
        },
      },
      tx,
    );

    return updated ?? before;
  });
}

/**
 * Архивация дома. Слаг остаётся занятым: по нему лежат документы,
 * и переиспользовать его под другой дом нельзя.
 */
export async function archiveHouse(
  actor: UserActor,
  houseId: string,
  executor: Executor = getDb(),
): Promise<House> {
  const before = await requireHouse(actor.context, houseId, executor);

  assertCan(actor.context, 'house.archive', { houseId });

  const archivedAt = now();

  return executor.transaction(async (tx) => {
    const updated = await patchHouse(actor.context, houseId, { archivedAt }, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.houseArchived,
        entityType: 'house',
        entityId: houseId,
        before: { archivedAt: before.archivedAt },
        after: { archivedAt },
      },
      tx,
    );

    return updated ?? before;
  });
}
