import { getDb, type Executor } from '@/db/client';
import {
  createRatingEvent,
  listRatingEvents,
  listRatingRules,
  putRefRatingEvent,
} from '@/db/repositories/rating';
import { listResidencies } from '@/db/repositories/residencies';
import {
  DEFAULT_RATING_RULES,
  deltaForScore,
  foldRating,
  ratingYearStart,
  type DownThresholdRule,
  type RatingRules,
  type UpThresholdRule,
} from '@/domain/rating';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { AccessContext } from '@/db/access';
import type { RatingEvent, RatingRule } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Рейтинг: события, дельты и число (docs/03-BUSINESS-RULES.md §5, §7).
 *
 * Значение нигде не хранится — оно складывается из событий года (P5-4).
 * Правила приходят из таблицы: сеть, поверх неё дом (§5.5), и только если
 * их нет — значения по умолчанию из §5.2.
 */
export interface RatingDeps {
  executor?: Executor;
  /** День, к которому относится действие: из него выводится год рейтинга. */
  today?: BusinessDate;
  instant?: Date;
}

function executorOf(deps: RatingDeps): Executor {
  return deps.executor ?? getDb();
}

/** Дом жильца: правила переопределяются по дому, а колонки дома у него нет (D11). */
async function houseOfUser(
  context: AccessContext,
  userId: string,
  executor: Executor,
): Promise<string | null> {
  const [residency] = await listResidencies(context, { userId }, executor);

  return residency?.houseId ?? null;
}

function numberFrom(config: unknown, key: string): number | null {
  if (typeof config !== 'object' || config === null) {
    return null;
  }

  const value = (config as Record<string, unknown>)[key];

  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Правила дома: значения по умолчанию, поверх — сеть, поверх — дом (§5.5).
 *
 * Строка правила выигрывает по коду, а не по всей таблице: суперадмин
 * меняет одну дельту, не переписывая остальные.
 */
export async function resolveRatingRules(
  context: AccessContext,
  houseId: string | null,
  executor: Executor = getDb(),
): Promise<RatingRules> {
  const [network, house] = await Promise.all([
    listRatingRules(context, { networkOnly: true }, executor),
    houseId === null
      ? Promise.resolve<RatingRule[]>([])
      : listRatingRules(context, { houseId }, executor),
  ]);

  const scoreDeltas: Record<number, number> = { ...DEFAULT_RATING_RULES.scoreDeltas };
  const actionDeltas: Record<string, number> = { ...DEFAULT_RATING_RULES.actionDeltas };
  const downThresholds = new Map<number, DownThresholdRule>(
    DEFAULT_RATING_RULES.downThresholds.map((rule) => [rule.threshold, rule]),
  );
  const upThresholds = new Map<number, UpThresholdRule>(
    DEFAULT_RATING_RULES.upThresholds.map((rule) => [rule.threshold, rule]),
  );

  for (const rule of [...network, ...house]) {
    if (rule.kind === 'score_delta') {
      const score = numberFrom(rule.config, 'score');
      const delta = numberFrom(rule.config, 'delta');

      if (score !== null && delta !== null) {
        if (rule.isActive) {
          scoreDeltas[score] = delta;
        } else {
          delete scoreDeltas[score];
        }
      }

      continue;
    }

    if (rule.kind === 'admin_action') {
      const delta = numberFrom(rule.config, 'delta');

      if (delta !== null) {
        if (rule.isActive) {
          actionDeltas[rule.code] = delta;
        } else {
          delete actionDeltas[rule.code];
        }
      }

      continue;
    }

    const threshold = numberFrom(rule.config, 'threshold');

    if (threshold === null) {
      continue;
    }

    if (rule.kind === 'threshold_down') {
      if (!rule.isActive) {
        downThresholds.delete(threshold);
        continue;
      }

      const actions = (rule.config as { actions?: unknown }).actions;

      downThresholds.set(threshold, {
        threshold,
        actions: Array.isArray(actions) ? actions.map(String) : [],
        fineAmount: numberFrom(rule.config, 'fine_amount') ?? 0,
      });

      continue;
    }

    if (!rule.isActive) {
      upThresholds.delete(threshold);
      continue;
    }

    upThresholds.set(threshold, {
      threshold,
      discountAmount: numberFrom(rule.config, 'discount_amount') ?? 0,
    });
  }

  const byThreshold = (a: { threshold: number }, b: { threshold: number }): number =>
    a.threshold - b.threshold;

  return {
    scoreDeltas,
    actionDeltas,
    downThresholds: [...downThresholds.values()].sort(byThreshold),
    upThresholds: [...upThresholds.values()].sort(byThreshold),
  };
}

export interface ScoreEventInput {
  userId: string;
  houseId: string;
  assignmentId: string;
  /** Оценка 1–10 или `null`: без оценки события нет. */
  score: number | null;
  /** Дата уборки: год рейтинга берётся от неё, а не от дня правки. */
  date: BusinessDate;
  /** Отменённое занятие влияния на рейтинг не имеет (§7). */
  cancelled?: boolean;
}

/**
 * Событие за оценку уборки — системным путём, без отдельного права (P3-1).
 *
 * Его зовут выставление оценки, смена статуса занятия и автозакрытие дня:
 * право на них уже проверено по самой операции. Событие одно на назначение,
 * поэтому переоценка правит дельту, а отмена обнуляет её.
 */
export async function syncScoreEvent(
  actor: UserActor,
  input: ScoreEventInput,
  deps: RatingDeps = {},
): Promise<RatingEvent | null> {
  const executor = executorOf(deps);
  const instant = deps.instant ?? now();

  if (input.score === null) {
    return null;
  }

  const rules = await resolveRatingRules(actor.context, input.houseId, executor);
  const cancelled = input.cancelled === true;

  return putRefRatingEvent(
    actor.context,
    {
      userId: input.userId,
      type: cancelled ? 'score:cancelled' : `score:${String(input.score)}`,
      delta: cancelled ? 0 : deltaForScore(rules, input.score),
      refType: 'rotation_assignment',
      refId: input.assignmentId,
      effectiveAt: instant,
      periodStart: ratingYearStart(input.date),
    },
    executor,
  );
}

export interface AdminEventInput {
  userId: string;
  /** Код действия из правил: `help`, `violation`, `warning` и прочие (§5.2). */
  type: string;
  /** Причина обязательна: без неё событие ничем не отличается от произвола. */
  reason: string;
  note?: string;
}

/** Действие админа (§5.2): дельта из правил дома, причина и запись в журнал. */
export async function addRatingEvent(
  actor: UserActor,
  input: AdminEventInput,
  deps: RatingDeps = {},
): Promise<RatingEvent> {
  const executor = executorOf(deps);
  const instant = deps.instant ?? now();
  const today = deps.today ?? todayInAlmaty(instant);

  const houseId = await houseOfUser(actor.context, input.userId, executor);

  if (houseId === null) {
    throw new NotFoundError('Проживание не найдено');
  }

  assertCan(actor.context, 'rating.event', { houseId, userId: input.userId });

  const reason = input.reason.trim();

  if (reason === '') {
    throw new ValidationError('rating.errors.reasonRequired');
  }

  const rules = await resolveRatingRules(actor.context, houseId, executor);
  const delta = rules.actionDeltas[input.type];

  if (delta === undefined) {
    throw new ValidationError('rating.errors.unknownAction');
  }

  return executor.transaction(async (tx) => {
    const event = await createRatingEvent(
      actor.context,
      {
        userId: input.userId,
        type: input.type,
        delta,
        refType: 'admin_action',
        note: input.note === undefined ? reason : `${reason}. ${input.note}`,
        effectiveAt: instant,
        periodStart: ratingYearStart(today),
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.ratingEventAdded,
        entityType: 'rating_event',
        entityId: event.id,
        after: { userId: input.userId, type: input.type, delta, reason },
      },
      tx,
    );

    return event;
  });
}

/** Число рейтинга на день: свёртка событий года с жёсткими границами (§5.1). */
export async function readRating(
  actor: UserActor,
  userId: string,
  deps: RatingDeps = {},
): Promise<number> {
  const executor = executorOf(deps);
  const today = deps.today ?? todayInAlmaty(deps.instant ?? now());

  const houseId = await houseOfUser(actor.context, userId, executor);

  assertCan(actor.context, 'rating.read', { houseId: houseId ?? undefined, userId });

  const events = await listRatingEvents(
    actor.context,
    { userId, periodStart: ratingYearStart(today) },
    executor,
  );

  return foldRating(events.map((event) => event.delta));
}

/**
 * История событий: админу и суперадмину (§5.6).
 *
 * Жильцу не отдаётся даже своя: §5.6 обещает ему только число, а оценка
 * уборки видна лишь админу (§7) — из истории она читалась бы напрямую.
 */
export async function readRatingHistory(
  actor: UserActor,
  userId: string,
  deps: RatingDeps = {},
): Promise<RatingEvent[]> {
  const executor = executorOf(deps);
  const today = deps.today ?? todayInAlmaty(deps.instant ?? now());

  const houseId = await houseOfUser(actor.context, userId, executor);

  assertCan(actor.context, 'rating.history', { houseId: houseId ?? undefined, userId });

  return listRatingEvents(actor.context, { userId, periodStart: ratingYearStart(today) }, executor);
}
