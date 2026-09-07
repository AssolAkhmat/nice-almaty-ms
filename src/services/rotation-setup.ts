import { getDb, type Executor } from '@/db/client';
import { listAreas, listBeds, requireArea } from '@/db/repositories/areas';
import { requireHouse } from '@/db/repositories/houses';
import {
  createChecklist,
  createEligibilityGroup,
  listAreaEligibility,
  listChecklists,
  listEligibilityGroups,
  listEligibilityMembers,
  replaceAreaEligibility,
  requireChecklist,
  requireEligibilityGroup,
  updateChecklist,
  updateEligibilityGroup,
  type EligibilityMemberRow,
} from '@/db/repositories/rotations';
import { parseEligibilityRule, resolveEligibility } from '@/domain/eligibility';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { now } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { Area, AreaChecklist, Bed, EligibilityGroup } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Настройка ротаций дома: чек-листы зон и группы допуска
 * (docs/03-BUSINESS-RULES.md §6.1, docs/04-MODULES/11-users-settings.md).
 *
 * Ряды и расписание — соседние таски фазы; здесь только то, из чего они
 * собираются. Право одно на весь раздел — `settings.house.write`: модуль 11
 * ведёт чек-листы и группы в настройках дома наравне с зонами и местами.
 */
type ChecklistType = 'regular' | 'general';

export interface RotationSetupDeps {
  executor?: Executor;
}

function executorOf(deps: RotationSetupDeps): Executor {
  return deps.executor ?? getDb();
}

export interface AreaSetupView {
  area: Area;
  checklists: AreaChecklist[];
  /** Идентификаторы групп, допущенных к зоне по каждому виду уборки. */
  eligibility: { regular: string[]; general: string[] };
}

export interface RotationSetupView {
  houseId: string;
  houseName: string;
  areas: AreaSetupView[];
  groups: EligibilityGroup[];
  /** Жильцы дома: из них собираются включения и исключения групп. */
  members: EligibilityMemberRow[];
  /** Места дома: из них собираются слоты ряда. */
  beds: Bed[];
}

export async function readRotationSetup(
  actor: UserActor,
  houseId: string,
  deps: RotationSetupDeps = {},
): Promise<RotationSetupView> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.read', { houseId });

  const [house, areas, checklists, groups, links, members, beds] = await Promise.all([
    requireHouse(actor.context, houseId, executor),
    listAreas(actor.context, houseId, {}, executor),
    listChecklists(actor.context, houseId, {}, executor),
    listEligibilityGroups(actor.context, houseId, executor),
    listAreaEligibility(actor.context, houseId, executor),
    listEligibilityMembers(actor.context, houseId, executor),
    listBeds(actor.context, houseId, {}, executor),
  ]);

  return {
    houseId: house.id,
    houseName: house.name,
    areas: areas.map((area) => ({
      area,
      checklists: checklists.filter((checklist) => checklist.areaId === area.id),
      eligibility: {
        regular: links
          .filter((link) => link.areaId === area.id && link.checklistType === 'regular')
          .map((link) => link.groupId),
        general: links
          .filter((link) => link.areaId === area.id && link.checklistType === 'general')
          .map((link) => link.groupId),
      },
    })),
    groups,
    members,
    beds,
  };
}

export interface ChecklistInput {
  areaId: string;
  type: ChecklistType;
  title: string;
  items?: readonly string[];
  peopleNeeded?: number;
}

function assertTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') {
    throw new ValidationError('rotationSetup.errors.titleRequired');
  }

  return trimmed;
}

function assertPeopleNeeded(peopleNeeded: number): number {
  // Столько назначений получит каждое занятие зоны (инвариант 8): ноль
  // означал бы зону, которую никто не убирает, а дробь — половину человека.
  if (!Number.isSafeInteger(peopleNeeded) || peopleNeeded < 1) {
    throw new ValidationError('rotationSetup.errors.peopleNeededInvalid');
  }

  return peopleNeeded;
}

/** Пункты чек-листа: пустые строки отбрасываются, остальное — как ввёл админ. */
function cleanItems(items: readonly string[] | undefined): string[] {
  return (items ?? []).map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * Дом зоны. Чужая зона неотличима от несуществующей (P1-1).
 *
 * Право роли проверяется до обращения к данным: жилец получает отказ
 * по праву, а не «зона не найдена». Иначе один и тот же запрет читался бы
 * по-разному на чтении и на записи — там `settings.house.read` проверяется
 * первым и отвечает отказом.
 */
async function houseOfArea(actor: UserActor, areaId: string, executor: Executor): Promise<string> {
  assertCan(actor.context, 'settings.house.write', { houseId: actor.context.houseId });

  const area = await requireArea(actor.context, areaId, executor);

  return area.houseId;
}

/**
 * Сохранение чек-листа зоны.
 *
 * На зону приходится по одному чек-листу каждого вида (§6.1), поэтому
 * повторное сохранение правит существующий, а не заводит второй: иначе
 * админ получал бы ошибку уникальности вместо ожидаемой правки.
 */
export async function saveChecklist(
  actor: UserActor,
  input: ChecklistInput,
  deps: RotationSetupDeps = {},
): Promise<AreaChecklist> {
  const executor = executorOf(deps);

  const title = assertTitle(input.title);
  const peopleNeeded = assertPeopleNeeded(input.peopleNeeded ?? 1);
  const items = cleanItems(input.items);

  const houseId = await houseOfArea(actor, input.areaId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId });

  const existing = (
    await listChecklists(actor.context, houseId, { includeArchived: true }, executor)
  ).find((checklist) => checklist.areaId === input.areaId && checklist.type === input.type);

  return executor.transaction(async (tx) => {
    const checklist =
      existing === undefined
        ? await createChecklist(
            actor.context,
            { areaId: input.areaId, type: input.type, title, items, peopleNeeded },
            tx,
          )
        : await updateChecklist(
            actor.context,
            existing.id,
            { title, items, peopleNeeded, archivedAt: null },
            tx,
          );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.checklistSaved,
        entityType: 'area_checklist',
        entityId: checklist.id,
        before:
          existing === undefined
            ? undefined
            : { title: existing.title, peopleNeeded: existing.peopleNeeded },
        after: { areaId: checklist.areaId, type: checklist.type, title, peopleNeeded },
      },
      tx,
    );

    return checklist;
  });
}

export async function archiveChecklist(
  actor: UserActor,
  checklistId: string,
  deps: RotationSetupDeps = {},
): Promise<AreaChecklist> {
  const executor = executorOf(deps);

  const checklist = await requireChecklist(actor.context, checklistId, executor);
  const houseId = await houseOfArea(actor, checklist.areaId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId });

  return executor.transaction(async (tx) => {
    const archived = await updateChecklist(actor.context, checklistId, { archivedAt: now() }, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.checklistArchived,
        entityType: 'area_checklist',
        entityId: checklistId,
        before: { title: checklist.title },
      },
      tx,
    );

    return archived;
  });
}

export interface GroupInput {
  houseId: string;
  name: string;
  rule: unknown;
}

function assertRule(rule: unknown): unknown {
  try {
    return parseEligibilityRule(rule);
  } catch {
    // Домен объясняет причину подробно, интерфейсу нужен ключ перевода.
    throw new ValidationError('rotationSetup.errors.ruleInvalid');
  }
}

export async function createGroup(
  actor: UserActor,
  input: GroupInput,
  deps: RotationSetupDeps = {},
): Promise<EligibilityGroup> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.write', { houseId: input.houseId });
  const name = assertTitle(input.name);
  const rule = assertRule(input.rule);

  return executor.transaction(async (tx) => {
    const group = await createEligibilityGroup(
      actor.context,
      { houseId: input.houseId, name, rule },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.eligibilityGroupSaved,
        entityType: 'eligibility_group',
        entityId: group.id,
        after: { houseId: input.houseId, name, rule },
      },
      tx,
    );

    return group;
  });
}

export interface GroupPatch {
  name?: string;
  rule?: unknown;
}

export async function updateGroup(
  actor: UserActor,
  groupId: string,
  patch: GroupPatch,
  deps: RotationSetupDeps = {},
): Promise<EligibilityGroup> {
  const executor = executorOf(deps);

  const before = await requireEligibilityGroup(actor.context, groupId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: before.houseId });

  const name = patch.name === undefined ? undefined : assertTitle(patch.name);
  const rule = patch.rule === undefined ? undefined : assertRule(patch.rule);

  return executor.transaction(async (tx) => {
    const group = await updateEligibilityGroup(
      actor.context,
      groupId,
      {
        ...(name === undefined ? {} : { name }),
        ...(rule === undefined ? {} : { rule }),
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.eligibilityGroupSaved,
        entityType: 'eligibility_group',
        entityId: groupId,
        before: { name: before.name, rule: before.rule },
        after: { name: group.name, rule: group.rule },
      },
      tx,
    );

    return group;
  });
}

/** Кого группа допускает к зоне сегодня: правило плюс нынешний состав дома. */
export async function resolveGroup(
  actor: UserActor,
  groupId: string,
  deps: RotationSetupDeps = {},
): Promise<string[]> {
  const executor = executorOf(deps);

  const group = await requireEligibilityGroup(actor.context, groupId, executor);
  assertCan(actor.context, 'settings.house.read', { houseId: group.houseId });

  const members = await listEligibilityMembers(actor.context, group.houseId, executor);

  return resolveEligibility(parseEligibilityRule(group.rule), members);
}

export interface AreaEligibilityInput {
  areaId: string;
  checklistType: ChecklistType;
  groupIds: readonly string[];
}

export async function setAreaEligibility(
  actor: UserActor,
  input: AreaEligibilityInput,
  deps: RotationSetupDeps = {},
): Promise<void> {
  const executor = executorOf(deps);

  const houseId = await houseOfArea(actor, input.areaId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId });

  // Группа другого дома к зоне не привязывается: допуск собирается из своих.
  for (const groupId of input.groupIds) {
    const group = await requireEligibilityGroup(actor.context, groupId, executor);

    if (group.houseId !== houseId) {
      throw new NotFoundError('Группа допуска не найдена');
    }
  }

  await executor.transaction(async (tx) => {
    await replaceAreaEligibility(
      actor.context,
      input.areaId,
      input.checklistType,
      input.groupIds,
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.areaEligibilitySet,
        entityType: 'area',
        entityId: input.areaId,
        after: { checklistType: input.checklistType, groupIds: [...input.groupIds] },
      },
      tx,
    );
  });
}
