import { getDb, type Executor } from '@/db/client';
import { listAreas } from '@/db/repositories/areas';
import {
  createRotationRow,
  listRotationRows,
  requireRotationRow,
  updateRotationRow,
} from '@/db/repositories/rotations';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, toAlmatyParts, startOfDayUtc, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { RotationRow } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Ряды ротаций (docs/03-BUSINESS-RULES.md §6.4, `docs/tasks/PHASE-10.md` §2.2, §2.3).
 *
 * Ряд — это дом, тип, день недели и дата первой ротации; у комнатного ряда
 * ещё и его комната. Кто участвует и какие зоны убираются, живёт отдельно —
 * версиями состава и нормы с датой вступления (`rotation-day-setup`):
 * состав меняется реже списка зон, и правятся они порознь (P10-5, P10-17).
 * Прежний ряд «места и зоны одним махом» вместе с инвариантом 9 снят.
 */
export interface RotationRowsDeps {
  executor?: Executor;
  includeInactive?: boolean;
}

function executorOf(deps: RotationRowsDeps): Executor {
  return deps.executor ?? getDb();
}

export interface RowInput {
  /** Пусто — заводится новый ряд; заполнено — правится существующий. */
  rowId?: string;
  houseId: string;
  name: string;
  type: 'common' | 'room';
  /** 0 — воскресенье, 6 — суббота. */
  weekday: number;
  startDate: BusinessDate;
  /** Комната комнатного ряда (§6.4); у ряда общих зон её нет. */
  roomAreaId?: string | null;
  sortOrder?: number;
}

export async function readRows(
  actor: UserActor,
  houseId: string,
  deps: RotationRowsDeps = {},
): Promise<RotationRow[]> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.read', { houseId });

  return listRotationRows(
    actor.context,
    houseId,
    deps.includeInactive === true ? { includeInactive: true } : {},
    executor,
  );
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new ValidationError('rotationRows.errors.nameRequired');
  }

  return trimmed;
}

/** День недели даты по календарю Алматы: 0 — воскресенье, 6 — суббота. */
function weekdayOf(date: BusinessDate): number {
  return toAlmatyParts(startOfDayUtc(date)).weekday;
}

function assertSchedule(input: RowInput): BusinessDate {
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    throw new ValidationError('rotationRows.errors.weekdayInvalid');
  }

  // Комнатные ряды идут по воскресеньям (§6.4) — это часть их определения,
  // а не настройка: комната достаётся одному жильцу на неделю.
  if (input.type === 'room' && input.weekday !== 0) {
    throw new ValidationError('rotationRows.errors.roomRowSunday');
  }

  const startDate = parseBusinessDate(input.startDate);

  // Дата первой ротации — от неё считается номер недели `k` (§2.4).
  // Не совпав с днём недели ряда, она сдвинула бы всю сетку на день.
  if (weekdayOf(startDate) !== input.weekday) {
    throw new ValidationError('rotationRows.errors.startDateWeekday');
  }

  return startDate;
}

/**
 * Комната комнатного ряда: жилая зона своего дома. Ряд общих зон комнаты
 * не имеет — какие зоны он убирает, говорит норма дня, а не сам ряд.
 */
async function resolveRoom(
  actor: UserActor,
  input: RowInput,
  executor: Executor,
): Promise<string | null> {
  if (input.type !== 'room') {
    return null;
  }

  const roomAreaId = input.roomAreaId ?? '';

  if (roomAreaId === '') {
    throw new ValidationError('rotationRows.errors.roomRequired');
  }

  const areas = await listAreas(actor.context, input.houseId, {}, executor);
  const area = areas.find((item) => item.id === roomAreaId);

  if (area === undefined) {
    // Чужая комната неотличима от несуществующей (P1-1).
    throw new NotFoundError('Зона не найдена');
  }

  if (area.type !== 'living') {
    throw new ValidationError('rotationRows.errors.roomRowLivingArea');
  }

  return area.id;
}

export async function saveRow(
  actor: UserActor,
  input: RowInput,
  deps: RotationRowsDeps = {},
): Promise<RotationRow> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'settings.house.write', { houseId: input.houseId });

  const name = assertName(input.name);
  const startDate = assertSchedule(input);
  const roomAreaId = await resolveRoom(actor, input, executor);

  const existing =
    input.rowId === undefined
      ? null
      : await requireRotationRow(actor.context, input.rowId, executor);

  return executor.transaction(async (tx) => {
    const row =
      existing === null
        ? await createRotationRow(
            actor.context,
            {
              houseId: input.houseId,
              name,
              type: input.type,
              weekday: input.weekday,
              startDate,
              roomAreaId,
              ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
            },
            tx,
          )
        : await updateRotationRow(
            actor.context,
            existing.id,
            {
              name,
              type: input.type,
              weekday: input.weekday,
              startDate,
              roomAreaId,
              isActive: true,
              ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
            },
            tx,
          );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationRowSaved,
        entityType: 'rotation_row',
        entityId: row.id,
        before:
          existing === null
            ? undefined
            : { name: existing.name, weekday: existing.weekday, startDate: existing.startDate },
        after: {
          houseId: input.houseId,
          name,
          type: input.type,
          weekday: input.weekday,
          startDate,
          roomAreaId,
        },
      },
      tx,
    );

    return row;
  });
}

/**
 * Ряд не удаляется, а выключается: занятия, уже сгенерированные по нему,
 * ссылаются на ряд, и удаление стёрло бы историю уборок вместе с ним.
 */
export async function archiveRow(
  actor: UserActor,
  rowId: string,
  deps: RotationRowsDeps = {},
): Promise<RotationRow> {
  const executor = executorOf(deps);

  const row = await requireRotationRow(actor.context, rowId, executor);
  assertCan(actor.context, 'settings.house.write', { houseId: row.houseId });

  return executor.transaction(async (tx) => {
    const archived = await updateRotationRow(actor.context, rowId, { isActive: false }, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationRowArchived,
        entityType: 'rotation_row',
        entityId: rowId,
        before: { name: row.name },
      },
      tx,
    );

    return archived;
  });
}
