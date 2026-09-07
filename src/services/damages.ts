import { getDb, type Executor } from '@/db/client';
import { findLedgerEntryBySource } from '@/db/repositories/accounts';
import {
  addDamageShares,
  createDamage as insertDamage,
  listDamages,
  listDamageShares,
  requireDamage,
  updateDamage,
} from '@/db/repositories/damages';
import { createDepositTransaction } from '@/db/repositories/invoices';
import { listHouseRoster } from '@/db/repositories/residencies';
import { resolveDamageParticipants, splitDamage, type DamageSplitMode } from '@/domain/damage';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { postDamageCharge, reverseEntry } from './ledger';

import type { Damage, DamageShare } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Ущерб: деление, списание с депозитов и сторно
 * (docs/03-BUSINESS-RULES.md §8, docs/04-MODULES/07-damages.md).
 *
 * Кто и сколько платит — чистые функции `src/domain/damage.ts`. Здесь
 * собирается всё, что должно случиться разом: доли, движения депозитов
 * и проводка в фонд дома. Разъехаться им нельзя: доля без движения
 * депозита — это деньги, которые никто не заплатил.
 */
export interface DamageDeps {
  executor?: Executor;
  today?: BusinessDate;
  instant?: Date;
}

function resolve(deps: DamageDeps): { executor: Executor; today: BusinessDate; instant: Date } {
  const instant = deps.instant ?? now();

  return {
    executor: deps.executor ?? getDb(),
    today: deps.today ?? todayInAlmaty(instant),
    instant,
  };
}

export interface DamageInput {
  houseId: string;
  title: string;
  description?: string | null | undefined;
  amount: number;
  receiptFileId?: string | null | undefined;
  splitMode: DamageSplitMode;
  /** Для режимов `single`, `custom` и `all_except`. */
  userIds?: readonly string[] | undefined;
  /** Для режима `room`. */
  areaId?: string | null | undefined;
}

export interface DamagePreviewShare {
  residencyId: string;
  userId: string;
  amount: number;
}

export interface DamagePreview {
  shares: DamagePreviewShare[];
  /** Излишек округления — в фонд дома (§0, §8). */
  surplus: number;
  /** Сколько всего снимается с депозитов: сумма ущерба плюс излишек. */
  charged: number;
}

export interface DamageResult {
  damage: Damage;
  shares: DamageShare[];
}

function assertAmount(amount: number): void {
  // Деньги — целые тенге (§0). Ущерб на ноль тенге делить не с чего.
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ValidationError('damages.errors.amountInvalid');
  }
}

function assertTitle(title: string): void {
  if (title.trim() === '') {
    throw new ValidationError('damages.errors.titleRequired');
  }
}

/**
 * Доли участников по режиму деления. Пустой список участников — отказ,
 * а не пустой ущерб: сумма, которую не с кого списать, тихо исчезла бы,
 * а поломка осталась бы неоплаченной.
 */
async function computeShares(
  actor: UserActor,
  input: DamageInput,
  executor: Executor,
): Promise<DamagePreview> {
  const roster = await listHouseRoster(actor.context, input.houseId, executor);

  let participants: string[];

  try {
    participants = resolveDamageParticipants(
      {
        mode: input.splitMode,
        config: {
          ...(input.userIds === undefined ? {} : { userIds: input.userIds }),
          ...(input.areaId === undefined ? {} : { areaId: input.areaId }),
        },
      },
      roster.map((entry) => ({ userId: entry.userId, areaId: entry.areaId })),
    );
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ValidationError('damages.errors.noParticipants');
    }

    throw error;
  }

  const byUser = new Map(roster.map((entry) => [entry.userId, entry.residencyId]));
  const split = splitDamage(input.amount, participants);

  return {
    shares: split.shares.map((share) => ({
      residencyId: byUser.get(share.userId) ?? '',
      userId: share.userId,
      amount: share.amount,
    })),
    surplus: split.surplus,
    charged: input.amount + split.surplus,
  };
}

/**
 * Предпросмотр перед сохранением (модуль 7): кто участвует, сколько с каждого
 * и каков излишек. Ничего не записывает — админ обязан увидеть деление
 * до того, как деньги уйдут с депозитов.
 */
export async function previewDamage(
  actor: UserActor,
  input: DamageInput,
  deps: DamageDeps = {},
): Promise<DamagePreview> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'damage.create', { houseId: input.houseId });
  assertAmount(input.amount);

  return computeShares(actor, input, executor);
}

/**
 * Проведение ущерба: доли, списание с депозитов и проводка
 * «Депозитный фонд → Фонд дома» (§10.1). В фонд дома уходит сумма долей,
 * то есть ущерб вместе с излишком округления (§8).
 */
export async function createDamage(
  actor: UserActor,
  input: DamageInput,
  deps: DamageDeps = {},
): Promise<DamageResult> {
  const { executor, today } = resolve(deps);

  assertCan(actor.context, 'damage.create', { houseId: input.houseId });
  assertTitle(input.title);
  assertAmount(input.amount);

  const preview = await computeShares(actor, input, executor);

  return executor.transaction(async (tx) => {
    const damage = await insertDamage(
      actor.context,
      {
        houseId: input.houseId,
        title: input.title.trim(),
        description: input.description ?? null,
        amount: input.amount,
        receiptFileId: input.receiptFileId ?? null,
        splitMode: input.splitMode,
        splitConfig: {
          ...(input.userIds === undefined ? {} : { userIds: [...input.userIds] }),
          ...(input.areaId == null ? {} : { areaId: input.areaId }),
        },
        surplus: preview.surplus,
        createdBy: actor.context.userId,
      },
      tx,
    );

    const shares = await addDamageShares(
      preview.shares.map((share) => ({
        damageId: damage.id,
        residencyId: share.residencyId,
        userId: share.userId,
        amount: share.amount,
      })),
      tx,
    );

    for (const share of preview.shares) {
      // Списание отрицательное: депозит вправе уйти в минус (§2.4).
      await createDepositTransaction(
        actor.context,
        {
          residencyId: share.residencyId,
          type: 'damage_share',
          amount: -share.amount,
          refType: 'damage',
          refId: damage.id,
          note: damage.title,
          createdBy: actor.context.userId,
        },
        tx,
      );
    }

    await postDamageCharge(
      actor,
      { houseId: input.houseId, sourceId: damage.id, amount: preview.charged, date: today },
      { executor: tx, today },
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.damageCreated,
        entityType: 'damage',
        entityId: damage.id,
        after: {
          title: damage.title,
          amount: damage.amount,
          splitMode: damage.splitMode,
          participants: preview.shares.length,
          surplus: preview.surplus,
        },
      },
      tx,
    );

    return { damage, shares };
  });
}

/**
 * Сторно ущерба — только суперадмин (§8). Ущерб не удаляется: обратная
 * проводка и возвратные движения депозитов оставляют в истории и списание,
 * и его отмену. Жилец должен видеть обе стороны, а не исчезнувшую строку.
 */
export async function reverseDamage(
  actor: UserActor,
  damageId: string,
  deps: DamageDeps = {},
): Promise<Damage> {
  const { executor, instant } = resolve(deps);

  const damage = await requireDamage(actor.context, damageId, executor);
  assertCan(actor.context, 'damage.reverse', { houseId: damage.houseId });

  if (damage.reversedAt !== null) {
    throw new ConflictError('damages.errors.alreadyReversed');
  }

  const shares = await listDamageShares(damage.id, executor);
  const entry = await findLedgerEntryBySource(actor.context, 'damage', damage.id, executor);

  if (entry === null) {
    throw new NotFoundError('Проводка ущерба не найдена');
  }

  return executor.transaction(async (tx) => {
    for (const share of shares) {
      await createDepositTransaction(
        actor.context,
        {
          residencyId: share.residencyId,
          type: 'damage_reversal',
          amount: share.amount,
          refType: 'damage',
          refId: damage.id,
          note: `Сторно: ${damage.title}`,
          createdBy: actor.context.userId,
        },
        tx,
      );
    }

    await reverseEntry(actor, entry.id, { executor: tx });

    const updated = await updateDamage(
      actor.context,
      damage.id,
      { reversedAt: instant, reversedBy: actor.context.userId },
      tx,
    );

    if (updated === null) {
      throw new ConflictError('damages.errors.notUpdated');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.damageReversed,
        entityType: 'damage',
        entityId: damage.id,
        after: { title: damage.title, amount: damage.amount, returned: shares.length },
      },
      tx,
    );

    return updated;
  });
}

export interface DamageRow {
  damage: Damage;
  shares: DamageShare[];
}

/** Список ущербов дома для админа (модуль 7, «Просмотр»). */
export async function listHouseDamages(
  actor: UserActor,
  houseId: string,
  deps: DamageDeps = {},
): Promise<DamageRow[]> {
  const { executor } = resolve(deps);

  assertCan(actor.context, 'damage.read', { houseId });

  const damages = await listDamages(actor.context, { houseId }, executor);

  return Promise.all(
    damages.map(async (damage) => ({
      damage,
      shares: await listDamageShares(damage.id, executor),
    })),
  );
}
