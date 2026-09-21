import {
  createTemporaryResident,
  deleteTemporaryResident,
  listTemporaryResidents,
  requireTemporaryResident,
  updateTemporaryResident,
  type TemporaryFilter,
  type TemporaryResidentRow,
} from '@/db/repositories/temporary-residents';
import { assertCan } from '@/lib/authz';
import { ValidationError } from '@/lib/errors';
import { compareBusinessDates, now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { Executor } from '@/db/client';
import type { Period } from '@/db/period';
import type { TemporaryResident } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Временные жильцы для ротаций (T11.3, указание владельца 21 сентября 2026).
 *
 * Переходный период: не все жильцы заведены в систему, а расписание нужно
 * строить уже сейчас. Временный жилец — это имя и пол, привязанные к месту
 * на период. Входа в систему у него нет, как нет профиля, документов,
 * депозита, счетов, коммуналки, рейтинга и долгов доп. ротаций: если человеку
 * нужно что-то из этого, он уже настоящий жилец.
 *
 * Пересечения периодов запрещает база (миграция 0027): ограничение исключения
 * на место и два триггера против настоящих проживаний. Сервис их не дублирует,
 * а переводит отказ базы в понятную человеку ошибку.
 */
export interface TemporaryDeps {
  executor?: Executor;
  today?: BusinessDate;
}

/** Код нарушения исключения: им отвечают и EXCLUDE, и оба триггера. */
const EXCLUSION_VIOLATION = '23P01';

function isBedTaken(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause;

  return cause?.code === EXCLUSION_VIOLATION;
}

/** Отказ базы о занятом месте — в сообщение, которое человек прочитает. */
async function withBedTakenMessage<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (isBedTaken(error)) {
      throw new ValidationError('temporaryResidents.errors.bedTaken');
    }

    throw error;
  }
}

function assertName(name: string): string {
  const trimmed = name.trim();

  if (trimmed === '') {
    throw new ValidationError('temporaryResidents.errors.nameRequired');
  }

  return trimmed;
}

function assertPeriod(period: Period): Period {
  if (period.to !== null && compareBusinessDates(period.from, period.to) >= 0) {
    throw new ValidationError('temporaryResidents.errors.periodEmpty');
  }

  return period;
}

export async function listTemporary(
  actor: UserActor,
  filter: TemporaryFilter,
  deps: TemporaryDeps = {},
): Promise<TemporaryResidentRow[]> {
  const executor = deps.executor;

  assertCan(actor.context, 'temporaryResident.read', { houseId: filter.houseId });

  return executor === undefined
    ? listTemporaryResidents(actor.context, filter)
    : listTemporaryResidents(actor.context, filter, executor);
}

export interface AddTemporaryInput {
  houseId: string;
  bedId: string;
  name: string;
  sex: 'male' | 'female';
  period: Period;
  note?: string | null;
}

export async function addTemporary(
  actor: UserActor,
  input: AddTemporaryInput,
  deps: TemporaryDeps = {},
): Promise<TemporaryResident> {
  const executor = deps.executor ?? undefined;

  assertCan(actor.context, 'temporaryResident.write', { houseId: input.houseId });

  const name = assertName(input.name);
  const period = assertPeriod(input.period);

  const run = async (tx: Executor): Promise<TemporaryResident> => {
    const created = await withBedTakenMessage(() =>
      createTemporaryResident(actor.context, { ...input, name, period }, tx),
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.temporaryResidentCreated,
        entityType: 'temporary_resident',
        entityId: created.id,
        after: {
          name: created.name,
          sex: created.sex,
          bedId: created.bedId,
          period: created.period,
        },
      },
      tx,
    );

    return created;
  };

  return executor === undefined
    ? (await import('@/db/client')).getDb().transaction(run)
    : run(executor);
}

export interface EditTemporaryInput {
  name?: string;
  sex?: 'male' | 'female';
  period?: Period;
  note?: string | null;
}

export async function editTemporary(
  actor: UserActor,
  id: string,
  patch: EditTemporaryInput,
  deps: TemporaryDeps = {},
): Promise<TemporaryResident> {
  const executor = deps.executor ?? undefined;

  const run = async (tx: Executor): Promise<TemporaryResident> => {
    const before = await requireTemporaryResident(actor.context, id, tx);
    assertCan(actor.context, 'temporaryResident.write', { houseId: before.houseId });

    const updated = await withBedTakenMessage(() =>
      updateTemporaryResident(
        actor.context,
        id,
        {
          ...(patch.name === undefined ? {} : { name: assertName(patch.name) }),
          ...(patch.sex === undefined ? {} : { sex: patch.sex }),
          ...(patch.period === undefined ? {} : { period: assertPeriod(patch.period) }),
          ...(patch.note === undefined ? {} : { note: patch.note }),
        },
        tx,
      ),
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.temporaryResidentUpdated,
        entityType: 'temporary_resident',
        entityId: id,
        before: { name: before.name, sex: before.sex, period: before.period },
        after: { name: updated.name, sex: updated.sex, period: updated.period },
      },
      tx,
    );

    return updated;
  };

  return executor === undefined
    ? (await import('@/db/client')).getDb().transaction(run)
    : run(executor);
}

/**
 * Снять временного жильца с места.
 *
 * Прошлые занятия остаются с его именем: назначения ротаций хранят ссылку,
 * и запись не удаляется, пока на неё ссылаются. Поэтому «снять» — это
 * закрыть период сегодняшним днём, а удаляется только тот, кто ещё не начал.
 */
export async function removeTemporary(
  actor: UserActor,
  id: string,
  deps: TemporaryDeps = {},
): Promise<void> {
  const executor = deps.executor ?? undefined;
  const today = deps.today ?? todayInAlmaty(now());

  const run = async (tx: Executor): Promise<void> => {
    const before = await requireTemporaryResident(actor.context, id, tx);
    assertCan(actor.context, 'temporaryResident.write', { houseId: before.houseId });

    const startsAt = before.period.slice(1, before.period.indexOf(',')) as BusinessDate;
    const future = compareBusinessDates(startsAt, today) >= 0;

    if (future) {
      await deleteTemporaryResident(actor.context, id, tx);
    } else {
      await updateTemporaryResident(
        actor.context,
        id,
        { period: { from: startsAt, to: today } },
        tx,
      );
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.temporaryResidentRemoved,
        entityType: 'temporary_resident',
        entityId: id,
        before: { name: before.name, period: before.period },
        // Ещё не начавшийся удаляется целиком, поэтому «после» у него нет.
        ...(future ? {} : { after: { period: `[${startsAt},${today})` } }),
      },
      tx,
    );
  };

  if (executor === undefined) {
    await (await import('@/db/client')).getDb().transaction(run);

    return;
  }

  await run(executor);
}
