import { getDb, type Executor } from '@/db/client';
import { listFines, listRatingEvents, readThresholdStates } from '@/db/repositories/rating';
import { listResidencies } from '@/db/repositories/residencies';
import { listCalendarDictionaries, listRotationDebts } from '@/db/repositories/rotations';
import { foldRating, ratingYearStart } from '@/domain/rating';
import { assertCan } from '@/lib/authz';
import { now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { readRatingHistory, readRuleIdsByCode, resolveRatingRules } from './rating';
import { isRatingVisibleToResidents } from './settings';

import type { Fine, RatingEvent } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Экраны рейтинга (docs/03-BUSINESS-RULES.md §5.6, docs/04-MODULES/08-rating.md).
 *
 * Жилец видит только число — и то, пока суперадмин не скрыл рейтинг от всех.
 * Админ видит рейтинг жильцов своего дома, историю событий, пороги, долги
 * и штрафы. Что считается числом, решает ядро; здесь только сборка вида.
 */
export interface RatingViewsDeps {
  executor?: Executor;
  today?: BusinessDate;
}

function executorOf(deps: RatingViewsDeps): Executor {
  return deps.executor ?? getDb();
}

function todayOf(deps: RatingViewsDeps): BusinessDate {
  return deps.today ?? todayInAlmaty(now());
}

export interface RatingCard {
  /** `null` — рейтинг скрыт: числу нечего делать даже в разметке страницы. */
  rating: number | null;
  visible: boolean;
}

/** Карточка жильца: своё число. `null` — проживания нет, и рейтинга тоже. */
export async function readMyRatingCard(
  actor: UserActor,
  deps: RatingViewsDeps = {},
): Promise<RatingCard | null> {
  const executor = executorOf(deps);
  const today = todayOf(deps);

  const [residency] = await listResidencies(
    actor.context,
    { userId: actor.context.userId },
    executor,
  );

  if (residency === undefined) {
    return null;
  }

  assertCan(actor.context, 'rating.read', {
    houseId: residency.houseId,
    userId: actor.context.userId,
  });

  const visible =
    actor.context.role !== 'resident' ||
    (await isRatingVisibleToResidents(actor.context, executor));

  if (!visible) {
    return { rating: null, visible: false };
  }

  const events = await listRatingEvents(
    actor.context,
    { userId: actor.context.userId, periodStart: ratingYearStart(today) },
    executor,
  );

  return { rating: foldRating(events.map((event) => event.delta)), visible: true };
}

export interface HouseRatingRow {
  userId: string;
  name: string;
  rating: number;
  /** Непогашенные долги по дополнительным ротациям (§7). */
  debts: number;
  /** Сумма штрафов, ещё не попавших в счёт, в тенге. */
  finesPending: number;
}

export async function readHouseRating(
  actor: UserActor,
  houseId: string,
  deps: RatingViewsDeps = {},
): Promise<HouseRatingRow[]> {
  const executor = executorOf(deps);
  const today = todayOf(deps);

  assertCan(actor.context, 'rating.history', { houseId });

  const dictionaries = await listCalendarDictionaries(actor.context, houseId, executor);
  const userIds = dictionaries.members.map((member) => member.userId);

  const [debts, fines] = await Promise.all([
    listRotationDebts(actor.context, { userIds, on: today }, executor),
    listFines(actor.context, { houseId, status: 'pending' }, executor),
  ]);

  const rows: HouseRatingRow[] = [];

  for (const member of dictionaries.members) {
    const events = await listRatingEvents(
      actor.context,
      { userId: member.userId, periodStart: ratingYearStart(today) },
      executor,
    );

    rows.push({
      userId: member.userId,
      name: member.name,
      rating: foldRating(events.map((event) => event.delta)),
      debts: debts.filter((debt) => debt.userId === member.userId).length,
      finesPending: fines
        .filter((fine) => fine.userId === member.userId)
        .reduce((sum, fine) => sum + fine.amount, 0),
    });
  }

  return rows;
}

export interface ThresholdRow {
  kind: 'down' | 'up';
  threshold: number;
  /** Взведён — сработает при пересечении; снят — молчит до перезарядки. */
  armed: boolean;
  /** Сумма штрафа у порога вниз или скидки у порога вверх, в тенге. */
  amount: number;
}

export interface ResidentRatingView {
  userId: string;
  houseId: string;
  rating: number;
  events: RatingEvent[];
  thresholds: ThresholdRow[];
  debts: number;
  fines: Fine[];
}

/** Карточка жильца для админа: число, история, пороги, долги и штрафы. */
export async function readResidentRating(
  actor: UserActor,
  userId: string,
  deps: RatingViewsDeps = {},
): Promise<ResidentRatingView> {
  const executor = executorOf(deps);
  const today = todayOf(deps);

  const [residency] = await listResidencies(actor.context, { userId }, executor);
  const houseId = residency?.houseId ?? null;

  assertCan(actor.context, 'rating.history', {
    ...(houseId === null ? {} : { houseId }),
    userId,
  });

  const [events, rules, states, ruleIds, debts, fines] = await Promise.all([
    readRatingHistory(actor, userId, { executor, today }),
    resolveRatingRules(actor.context, houseId, executor),
    readThresholdStates(actor.context, userId, executor),
    readRuleIdsByCode(actor.context, houseId, executor),
    listRotationDebts(actor.context, { userIds: [userId], on: today }, executor),
    listFines(actor.context, { userId }, executor),
  ]);

  /*
   * Взведённость хранится по строке правила, а строки может ещё не быть:
   * пороги заводятся при первом срабатывании (P5-17). Нет строки — порог
   * ни разу не срабатывал, то есть взведён.
   */
  const armedByRule = new Map(states.map((state) => [state.ruleId, state.armed]));
  const armedOf = (code: string): boolean => {
    const ruleId = ruleIds.get(code);

    return ruleId === undefined ? true : (armedByRule.get(ruleId) ?? true);
  };

  const thresholds: ThresholdRow[] = [
    ...rules.downThresholds.map((rule) => ({
      kind: 'down' as const,
      threshold: rule.threshold,
      armed: armedOf(`down:${String(rule.threshold)}`),
      amount: rule.fineAmount,
    })),
    ...rules.upThresholds.map((rule) => ({
      kind: 'up' as const,
      threshold: rule.threshold,
      armed: armedOf(`up:${String(rule.threshold)}`),
      amount: rule.discountAmount,
    })),
  ];

  return {
    userId,
    houseId: houseId ?? '',
    rating: foldRating(events.map((event) => event.delta)),
    events,
    thresholds,
    debts: debts.length,
    fines,
  };
}
