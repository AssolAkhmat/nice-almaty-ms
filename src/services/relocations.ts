import { getDb, type Executor } from '@/db/client';
import { requireBed } from '@/db/repositories/areas';
import {
  assignBed,
  findOpenAssignment,
  releaseBed,
  requireResidency,
  updateResidency,
} from '@/db/repositories/residencies';
import { listEligibilityGroups, updateEligibilityGroup } from '@/db/repositories/rotations';
import { releaseTemporaryOnBed } from '@/db/repositories/temporary-residents';
import { parseEligibilityRule } from '@/domain/eligibility';
import { assertCan } from '@/lib/authz';
import { ConflictError, ValidationError } from '@/lib/errors';
import { compareBusinessDates, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { syncFutureAssignments } from './rotation-schedule';

import type { BedAssignment, EligibilityGroup, Residency } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Переселение жильца в другой дом (решение D26, указание владельца
 * от 22 сентября 2026).
 *
 * Это **не** расторжение и новое заселение: договор у жильца с ИП, а не
 * с домом. Строка проживания остаётся та же, и вместе с ней остаются
 * депозит и его история, стаж для правила «3 полных месяца» (§2.2),
 * рейтинг, долги доп. ротаций, история ущерба и номер договора. Меняются
 * дом, место и цена — с даты.
 *
 * «Дом сейчас» — это `residencies.house_id`; «дом тогда» живёт отрезками
 * занятости мест, и прошлое ими не переписывается. Поэтому коммуналка
 * старого дома за прожитые там дни остаётся за старым домом, а ротации
 * прошлых дней — с именем жильца в старом доме.
 */
export interface RelocationDeps {
  executor?: Executor;
  today?: BusinessDate;
}

export interface RelocationInput {
  residencyId: string;
  /** Дом, куда переселяют. */
  houseId: string;
  bedId: string;
  price?: number | undefined;
  /** Дата переселения; по умолчанию сегодня. */
  from?: BusinessDate | undefined;
  /**
   * Поимённые группы допуска покидаемого дома, из которых убрать жильца.
   * Пусто — не убирать ниоткуда: человек может вернуться, и потерянное
   * исключение вернулось бы молчаливым допуском (указание владельца).
   */
  leaveGroupIds?: readonly string[] | undefined;
}

export interface RelocationResult {
  residency: Residency;
  assignment: BedAssignment;
  fromHouseId: string;
  /** Группы старого дома, из которых жильца убрали по просьбе админа. */
  leftGroups: string[];
}

/**
 * Поимённые группы допуска дома, в которых назван этот жилец.
 *
 * Показывается админу при переселении: списки хранят голые идентификаторы
 * и сами не чистятся. Молча вычищать их нельзя — человек может вернуться,
 * и снятое исключение превратилось бы в тихий допуск туда, куда его
 * не пускали. Поэтому спрашиваем, а по умолчанию не трогаем.
 */
export async function groupsNamingUser(
  actor: UserActor,
  houseId: string,
  userId: string,
  deps: RelocationDeps = {},
): Promise<EligibilityGroup[]> {
  const executor = deps.executor ?? getDb();

  assertCan(actor.context, 'rotation.manage', { houseId });

  const groups = await listEligibilityGroups(actor.context, houseId, executor);

  return groups.filter((group) => {
    const rule = parseEligibilityRule(group.rule);

    return rule.includeUserIds.includes(userId) || rule.excludeUserIds.includes(userId);
  });
}

function withoutUser(group: EligibilityGroup, userId: string): Record<string, unknown> {
  const rule = parseEligibilityRule(group.rule);

  return {
    ...(group.rule as Record<string, unknown>),
    includeUserIds: rule.includeUserIds.filter((id) => id !== userId),
    excludeUserIds: rule.excludeUserIds.filter((id) => id !== userId),
  };
}

export async function relocateResidency(
  actor: UserActor,
  input: RelocationInput,
  deps: RelocationDeps = {},
): Promise<RelocationResult> {
  const executor = deps.executor ?? getDb();
  const today = deps.today ?? todayInAlmaty();

  const residency = await requireResidency(actor.context, input.residencyId, executor);
  const fromHouseId = residency.houseId;

  /*
   * Права нужны в обоих домах сразу: переселение — действие сети, а не дома.
   * Админ одного дома не может ни увести жильца к соседу, ни забрать чужого.
   */
  assertCan(actor.context, 'bed.assign', { houseId: fromHouseId, userId: residency.userId });
  assertCan(actor.context, 'bed.assign', { houseId: input.houseId, userId: residency.userId });

  if (input.houseId === fromHouseId) {
    // Смена места внутри дома — это назначение места, а не переселение.
    throw new ValidationError('relocations.errors.sameHouse');
  }

  const bed = await requireBed(actor.context, input.bedId, executor);

  if (bed.houseId !== input.houseId) {
    throw new ValidationError('beds.bedFromAnotherHouse');
  }

  const price = input.price ?? bed.defaultPrice;
  if (!Number.isInteger(price) || price < 0) {
    throw new ValidationError('beds.priceInvalid');
  }

  const from = input.from ?? today;

  /*
   * Переселение задним числом до заезда бессмысленно: человек не жил
   * в старом доме ни дня, и «история», которую мы бережём, пуста.
   */
  if (
    residency.moveInDate !== null &&
    compareBusinessDates(from, residency.moveInDate as BusinessDate) < 0
  ) {
    throw new ValidationError('relocations.errors.beforeMoveIn');
  }

  if (residency.status === 'archived') {
    throw new ConflictError('relocations.errors.archived');
  }

  const previous = await findOpenAssignment(residency.id, executor);

  return executor.transaction(async (tx) => {
    /* Место в старом доме освобождается с даты переселения, история цела. */
    if (previous !== null) {
      await releaseBed(residency.id, from, tx);
    }

    const moved = await updateResidency(
      actor.context,
      residency.id,
      { houseId: input.houseId },
      tx,
    );

    if (moved === null) {
      throw new ConflictError('relocations.errors.notUpdated');
    }

    /* Новое место освобождается от временных жильцов — как при заселении. */
    const releasedTemporaries = await releaseTemporaryOnBed(actor.context, bed.id, from, tx);

    for (const temporary of releasedTemporaries) {
      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.temporaryResidentReleased,
          entityType: 'temporary_resident',
          entityId: temporary.id,
          before: { name: temporary.name, period: temporary.period },
          after: { releasedFrom: from, residencyId: residency.id },
        },
        tx,
      );
    }

    const assignment = await assignBed(
      { residencyId: residency.id, bedId: bed.id, price, from, createdBy: actor.context.userId },
      tx,
    );

    const leftGroups: string[] = [];

    for (const groupId of input.leaveGroupIds ?? []) {
      const [group] = (await listEligibilityGroups(actor.context, fromHouseId, tx)).filter(
        (candidate) => candidate.id === groupId,
      );

      if (group === undefined) {
        continue;
      }

      await updateEligibilityGroup(
        actor.context,
        group.id,
        { rule: withoutUser(group, residency.userId) },
        tx,
      );
      leftGroups.push(group.id);
    }

    /*
     * Расписание пересобирается в ОБОИХ домах: место в старом доме осталось
     * без жильца, место в новом получило его. Прежний код звал пересборку
     * один раз и уже после смены дома — старый дом остался бы с дыркой,
     * о которой никто не сказал.
     */
    await syncFutureAssignments(actor, fromHouseId, from, { executor: tx, today: from });
    await syncFutureAssignments(actor, input.houseId, from, { executor: tx, today: from });

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.residencyRelocated,
        entityType: 'residency',
        entityId: residency.id,
        before: {
          houseId: fromHouseId,
          bedId: previous?.bedId ?? null,
          price: previous?.price ?? null,
        },
        after: { houseId: input.houseId, bedId: bed.id, price, from, leftGroups },
      },
      tx,
    );

    return { residency: moved, assignment, fromHouseId, leftGroups };
  });
}
