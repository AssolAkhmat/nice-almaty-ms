import { getDb, type Executor } from '@/db/client';
import { getSetting, putSetting } from '@/db/repositories/settings';
import {
  createAssignment,
  createOccurrence,
  listAreaEligibility,
  listAssignmentsFor,
  listChecklists,
  listEligibilityGroups,
  listEligibilityMembers,
  listGeneralCleaningParticipants,
  listOccurrences,
  updateAssignment,
  updateOccurrence,
} from '@/db/repositories/rotations';
import { parseEligibilityRule, resolveEligibility } from '@/domain/eligibility';
import {
  distributeGeneralCleaning,
  lastSundayOfMonth,
  type GeneralZone,
} from '@/domain/general-cleaning';
import { assertCan } from '@/lib/authz';
import { type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { UserActor } from './users';

/**
 * Генеральная уборка (docs/03-BUSINESS-RULES.md §6.5).
 *
 * Последнее воскресенье месяца; дата переносится вручную тем же переносом,
 * что и любая другая ротация. Расклад детерминирован по сиду «дом плюс дата»:
 * повторный расчёт того же дня даёт тот же результат, и его правят
 * переназначением, а не новой жеребьёвкой.
 */
export interface GeneralCleaningDeps {
  executor?: Executor;
}

function executorOf(deps: GeneralCleaningDeps): Executor {
  return deps.executor ?? getDb();
}

/** Ключ настройки дома: отменять ли обычную воскресную ротацию (§6.5). */
const CANCEL_REGULAR_KEY = 'rotations.cancelRegularOnGeneral';

export interface GeneralCleaningSettings {
  /** По умолчанию — отменять: §6.5 называет это поведением по умолчанию. */
  cancelRegular: boolean;
}

export async function readGeneralCleaningSettings(
  actor: UserActor,
  houseId: string,
  deps: GeneralCleaningDeps = {},
): Promise<GeneralCleaningSettings> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.read', {
    houseId,
    userId: actor.context.userId,
  });

  const setting = await getSetting(actor.context, 'house', houseId, CANCEL_REGULAR_KEY, executor);

  return { cancelRegular: setting?.value !== false };
}

export async function setCancelRegularOnGeneral(
  actor: UserActor,
  houseId: string,
  cancelRegular: boolean,
  deps: GeneralCleaningDeps = {},
): Promise<GeneralCleaningSettings> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.manage', { houseId });

  await putSetting(actor.context, 'house', houseId, CANCEL_REGULAR_KEY, cancelRegular, executor);

  return { cancelRegular };
}

/** Ближайшая дата генеральной уборки для месяца, в котором лежит `date`. */
export function generalCleaningDate(date: BusinessDate): BusinessDate {
  return lastSundayOfMonth(date);
}

export interface GeneralCleaningResult {
  created: number;
  cancelledRegular: number;
}

/**
 * «Распределить случайно» (§6.5).
 *
 * Участвуют все жильцы дома вместе с админом. Зоны берутся те, у которых есть
 * генеральный чек-лист; кого зона пускает, решают её группы допуска. Занятия
 * этого дня, уже заведённые раньше, не пересоздаются — расклад правится
 * переназначением, а не повторной жеребьёвкой.
 */
export async function generateGeneralCleaning(
  actor: UserActor,
  houseId: string,
  date: BusinessDate,
  deps: GeneralCleaningDeps = {},
): Promise<GeneralCleaningResult> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.manage', { houseId });

  const [checklists, groups, links, members, people, existing] = await Promise.all([
    listChecklists(actor.context, houseId, {}, executor),
    listEligibilityGroups(actor.context, houseId, executor),
    listAreaEligibility(actor.context, houseId, executor),
    listEligibilityMembers(actor.context, houseId, executor),
    listGeneralCleaningParticipants(actor.context, houseId, executor),
    listOccurrences(actor.context, houseId, { from: date, to: date }, executor),
  ]);

  const general = checklists.filter((checklist) => checklist.type === 'general');

  if (general.length === 0) {
    return { created: 0, cancelledRegular: 0 };
  }

  const groupById = new Map(groups.map((group) => [group.id, group]));

  const zones: GeneralZone[] = general.map((checklist) => {
    const allowed = links
      .filter((link) => link.areaId === checklist.areaId && link.checklistType === 'general')
      .map((link) => groupById.get(link.groupId))
      .filter((group) => group !== undefined);

    // Групп у зоны нет — убирать её может кто угодно из дома (§6.1).
    const eligibleUserIds =
      allowed.length === 0
        ? people
        : Array.from(
            new Set(
              allowed.flatMap((group) =>
                resolveEligibility(
                  parseEligibilityRule(group.rule),
                  members.map((member) => ({
                    userId: member.userId,
                    sex: member.sex,
                    areaId: member.areaId,
                  })),
                ),
              ),
            ),
          );

    return {
      areaId: checklist.areaId,
      checklistId: checklist.id,
      peopleNeeded: checklist.peopleNeeded,
      eligibleUserIds,
    };
  });

  const distribution = distributeGeneralCleaning(`${houseId}|${date}`, zones, people);

  let created = 0;

  const result = await executor.transaction(async (tx) => {
    for (const zone of distribution) {
      const already = existing.some(
        (occurrence) => occurrence.type === 'general' && occurrence.areaId === zone.areaId,
      );

      if (already) {
        continue;
      }

      const occurrence = await createOccurrence(
        actor.context,
        {
          houseId,
          areaId: zone.areaId,
          checklistId: zone.checklistId,
          date,
          type: 'general',
          createdBy: actor.context.userId,
        },
        tx,
      );

      created += 1;

      for (const userId of zone.userIds) {
        await createAssignment(
          actor.context,
          {
            occurrenceId: occurrence.id,
            userId,
            source: 'auto',
            state: userId === null ? 'needs_reassignment' : 'assigned',
          },
          tx,
        );
      }
    }

    // Обычная ротация этого дня по умолчанию уступает генеральной (§6.5).
    const { cancelRegular } = await readGeneralCleaningSettings(actor, houseId, { executor: tx });
    let cancelledRegular = 0;

    if (cancelRegular) {
      for (const occurrence of existing) {
        if (occurrence.type === 'general' || occurrence.status !== 'scheduled') {
          continue;
        }

        await updateOccurrence(actor.context, occurrence.id, { status: 'cancelled' }, tx);

        for (const assignment of await listAssignmentsFor([occurrence.id], tx)) {
          if (assignment.state !== 'cancelled') {
            await updateAssignment(assignment.id, { state: 'cancelled' }, tx);
          }
        }

        cancelledRegular += 1;
      }
    }

    if (created > 0 || cancelledRegular > 0) {
      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.generalCleaningPlanned,
          entityType: 'house',
          entityId: houseId,
          after: { date, created, cancelledRegular },
        },
        tx,
      );
    }

    return { created, cancelledRegular };
  });

  return result;
}
