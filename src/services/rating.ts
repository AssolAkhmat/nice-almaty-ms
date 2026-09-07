import { getDb, type Executor } from '@/db/client';
import { rotationDebts } from '@/db/schema';
import {
  createDiscount,
  createFine,
  createRatingEvent,
  ensureRatingRule,
  listDiscounts,
  listFines,
  listRatingEvents,
  listRatingRules,
  putRefRatingEvent,
  readThresholdStates,
  updateDiscount,
  updateFine,
  writeThresholdStates,
} from '@/db/repositories/rating';
import { listResidencies } from '@/db/repositories/residencies';
import { contractEndDate } from '@/domain/contract';
import {
  crossDown,
  crossUp,
  DEFAULT_RATING_RULES,
  deltaForScore,
  foldRating,
  ratingYearStart,
  type DownThresholdRule,
  type RatingRules,
  type UpThresholdRule,
} from '@/domain/rating';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { now, startOfDayUtc, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { appendInvoiceLine } from './invoices';

import type { AccessContext } from '@/db/access';
import type { Discount, Fine, RatingEvent, RatingRule } from '@/db/schema';
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

  const event = await putRefRatingEvent(
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

  await applyThresholds(
    actor,
    { userId: input.userId, houseId: input.houseId, today: input.date },
    { executor, instant },
  );

  return event;
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

    // Порог смотрит на рейтинг после события: сработать он может и от
    // одного действия сразу на нескольких уровнях (§5.2).
    await applyThresholds(
      actor,
      { userId: input.userId, houseId, today },
      { executor: tx, instant },
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

/** Строки правил порогов: состоянию и скидке нужно, на что сослаться. */
async function thresholdRuleIds(
  context: AccessContext,
  houseId: string,
  rules: RatingRules,
  executor: Executor,
): Promise<Map<string, string>> {
  const [network, house] = await Promise.all([
    listRatingRules(context, { networkOnly: true }, executor),
    listRatingRules(context, { houseId }, executor),
  ]);

  const idByCode = new Map<string, string>();

  for (const rule of [...network, ...house]) {
    idByCode.set(rule.code, rule.id);
  }

  for (const rule of rules.downThresholds) {
    const code = `down:${String(rule.threshold)}`;

    if (!idByCode.has(code)) {
      const created = await ensureRatingRule(
        context,
        {
          houseId: null,
          kind: 'threshold_down',
          code,
          config: {
            threshold: rule.threshold,
            actions: rule.actions,
            fine_amount: rule.fineAmount,
          },
        },
        executor,
      );

      idByCode.set(code, created.id);
    }
  }

  for (const rule of rules.upThresholds) {
    const code = `up:${String(rule.threshold)}`;

    if (!idByCode.has(code)) {
      const created = await ensureRatingRule(
        context,
        {
          houseId: null,
          kind: 'threshold_up',
          code,
          config: { threshold: rule.threshold, discount_amount: rule.discountAmount },
        },
        executor,
      );

      idByCode.set(code, created.id);
    }
  }

  return idByCode;
}

/** Рейтинг без проверки прав: системный путь порогов знает, чей он считает. */
async function ratingOf(
  context: AccessContext,
  userId: string,
  today: BusinessDate,
  executor: Executor,
): Promise<number> {
  const events = await listRatingEvents(
    context,
    { userId, periodStart: ratingYearStart(today) },
    executor,
  );

  return foldRating(events.map((event) => event.delta));
}

/**
 * Пороги после события (§5.3–5.4) — системным путём, как и само событие.
 *
 * Срабатывание однократное: порог взводится обратно, только когда рейтинг
 * возвращается за него. Скидка не начисляется, а предлагается — подтверждает
 * её суперадмин.
 */
export async function applyThresholds(
  actor: UserActor,
  input: { userId: string; houseId: string; today: BusinessDate },
  deps: RatingDeps = {},
): Promise<void> {
  const executor = executorOf(deps);
  const instant = deps.instant ?? now();

  const rules = await resolveRatingRules(actor.context, input.houseId, executor);
  const ids = await thresholdRuleIds(actor.context, input.houseId, rules, executor);
  const rating = await ratingOf(actor.context, input.userId, input.today, executor);

  const stored = await readThresholdStates(actor.context, input.userId, executor);
  const armedByRule = new Map(stored.map((state) => [state.ruleId, state.armed]));

  const armedOf = (code: string): boolean => {
    const ruleId = ids.get(code);

    return ruleId === undefined ? true : (armedByRule.get(ruleId) ?? true);
  };

  const down = crossDown(
    rules,
    rating,
    rules.downThresholds.map((rule) => ({
      threshold: rule.threshold,
      armed: armedOf(`down:${String(rule.threshold)}`),
    })),
  );

  for (const triggered of down.triggered) {
    const ruleId = ids.get(`down:${String(triggered.threshold)}`) ?? null;

    if (triggered.actions.includes('extra_rotation')) {
      await executor.insert(rotationDebts).values({
        userId: input.userId,
        reason: `rating.threshold:${String(triggered.threshold)}`,
        // Долг не сгорает и обнуляется 1 июля — вместе с годом рейтинга (§7).
        expiresAt: contractEndDate(input.today),
      });
    }

    if (triggered.fineAmount > 0) {
      await createFine(
        actor.context,
        {
          userId: input.userId,
          houseId: input.houseId,
          amount: triggered.fineAmount,
          reason: `rating.threshold:${String(triggered.threshold)}`,
          ruleId,
        },
        executor,
      );
    }
  }

  const up = crossUp(
    rules,
    rating,
    rules.upThresholds.map((rule) => ({
      threshold: rule.threshold,
      armed: armedOf(`up:${String(rule.threshold)}`),
    })),
  );

  for (const triggered of up.triggered) {
    const ruleId = ids.get(`up:${String(triggered.threshold)}`);

    if (ruleId === undefined || triggered.discountAmount <= 0) {
      continue;
    }

    await createDiscount(
      actor.context,
      { userId: input.userId, amount: triggered.discountAmount, ruleId },
      executor,
    );
  }

  const states: { ruleId: string; armed: boolean; lastTriggeredAt?: Date }[] = [];

  for (const { prefix, state } of [
    ...down.states.map((state) => ({ prefix: 'down', state })),
    ...up.states.map((state) => ({ prefix: 'up', state })),
  ]) {
    const ruleId = ids.get(`${prefix}:${String(state.threshold)}`);

    if (ruleId === undefined) {
      continue;
    }

    states.push({
      ruleId,
      armed: state.armed,
      ...(state.armed ? {} : { lastTriggeredAt: instant }),
    });
  }

  await writeThresholdStates(actor.context, input.userId, states, executor);
}

/** Штрафы жильца: свои видит он сам, чужие — админ дома (§5.6). */
export async function listUserFines(
  actor: UserActor,
  userId: string,
  deps: RatingDeps = {},
): Promise<Fine[]> {
  const executor = executorOf(deps);
  const houseId = await houseOfUser(actor.context, userId, executor);

  if (houseId === null) {
    throw new NotFoundError('Проживание не найдено');
  }

  assertCan(actor.context, 'fine.read', { houseId, userId });

  return listFines(actor.context, { userId }, executor);
}

/** Штраф рукой админа (модуль 8): причина обязательна, как и у порогового. */
export async function addFine(
  actor: UserActor,
  input: { userId: string; amount: number; reason: string },
  deps: RatingDeps = {},
): Promise<Fine> {
  const executor = executorOf(deps);

  const houseId = await houseOfUser(actor.context, input.userId, executor);

  if (houseId === null) {
    throw new NotFoundError('Проживание не найдено');
  }

  assertCan(actor.context, 'fine.create', { houseId, userId: input.userId });

  const reason = input.reason.trim();

  if (reason === '') {
    throw new ValidationError('rating.errors.reasonRequired');
  }

  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new ValidationError('rating.errors.fineAmount');
  }

  return executor.transaction(async (tx) => {
    const fine = await createFine(
      actor.context,
      { userId: input.userId, houseId, amount: input.amount, reason },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.fineAdded,
        entityType: 'fine',
        entityId: fine.id,
        after: { userId: input.userId, amount: input.amount, reason },
      },
      tx,
    );

    return fine;
  });
}

/**
 * Отмена штрафа суперадмином (§5.5).
 *
 * До попадания в счёт — просто отмена. После — сторно отдельной строкой:
 * счёт уже видел жилец, и молча переписать его сумму значило бы менять
 * задним числом то, о чём ему сообщили.
 */
export async function cancelFine(
  actor: UserActor,
  fineId: string,
  reason: string,
  deps: RatingDeps = {},
): Promise<Fine> {
  const executor = executorOf(deps);

  const all = await listFines(actor.context, {}, executor);
  const fine = all.find((row) => row.id === fineId);

  if (fine === undefined) {
    throw new NotFoundError('Штраф не найден');
  }

  assertCan(actor.context, 'fine.cancel', { houseId: fine.houseId, userId: fine.userId });

  const trimmed = reason.trim();

  if (trimmed === '') {
    throw new ValidationError('rating.errors.reasonRequired');
  }

  if (fine.status === 'cancelled') {
    throw new ConflictError('rating.errors.fineCancelled');
  }

  return executor.transaction(async (tx) => {
    if (fine.status === 'applied' && fine.invoiceId !== null) {
      await appendInvoiceLine(
        actor,
        fine.invoiceId,
        { kind: 'fine', title: 'Сторно штрафа', amount: -fine.amount },
        { executor: tx },
      );
    }

    const cancelled = await updateFine(
      actor.context,
      fineId,
      {
        status: 'cancelled',
        cancelledBy: actor.context.userId,
        cancelledReason: trimmed,
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.fineCancelled,
        entityType: 'fine',
        entityId: fineId,
        before: { status: fine.status, amount: fine.amount },
        after: { status: 'cancelled', reason: trimmed },
      },
      tx,
    );

    return cancelled;
  });
}

/** Подтверждение скидки суперадмином (§5.4): система её только предлагает. */
export async function approveDiscount(
  actor: UserActor,
  discountId: string,
  deps: RatingDeps = {},
): Promise<Discount> {
  const executor = executorOf(deps);
  const instant = deps.instant ?? now();

  const all = await listDiscounts(actor.context, {}, executor);
  const discount = all.find((row) => row.id === discountId);

  if (discount === undefined) {
    throw new NotFoundError('Скидка не найдена');
  }

  assertCan(actor.context, 'discount.approve', { userId: discount.userId });

  return executor.transaction(async (tx) => {
    const approved = await updateDiscount(
      actor.context,
      discountId,
      { status: 'approved', approvedBy: actor.context.userId, approvedAt: instant },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.discountApproved,
        entityType: 'discount',
        entityId: discountId,
        before: { status: discount.status },
        after: { status: 'approved', amount: discount.amount },
      },
      tx,
    );

    return approved;
  });
}

/**
 * Скидка к счёту месяца (§5.4): наибольшая подтверждённая из тех, чей порог
 * рейтинг сейчас держит. Упал ниже — скидка в этом месяце не применяется,
 * подтверждение при этом остаётся.
 */
export async function discountForMonth(
  actor: UserActor,
  input: { userId: string; month: BusinessDate },
  deps: RatingDeps = {},
): Promise<number> {
  const executor = executorOf(deps);

  const approved = await listDiscounts(
    actor.context,
    { userId: input.userId, status: 'approved' },
    executor,
  );

  if (approved.length === 0) {
    return 0;
  }

  const rules = await listRatingRules(actor.context, {}, executor);
  const thresholdByRule = new Map(
    rules.map((rule) => [rule.id, numberFrom(rule.config, 'threshold')]),
  );
  const rating = await ratingOf(actor.context, input.userId, input.month, executor);

  let best = 0;

  for (const discount of approved) {
    const threshold = thresholdByRule.get(discount.ruleId) ?? null;

    if (threshold === null || rating <= threshold) {
      continue;
    }

    best = Math.max(best, discount.amount);
  }

  return best;
}

/** Штрафы, ожидающие ближайшего счёта: начисленные до этого месяца (§3). */
export async function pendingFinesForMonth(
  actor: UserActor,
  input: { userId: string; month: BusinessDate },
  deps: RatingDeps = {},
): Promise<Fine[]> {
  const executor = executorOf(deps);

  const fines = await listFines(
    actor.context,
    { userId: input.userId, status: 'pending' },
    executor,
  );

  const boundary = startOfDayUtc(input.month);

  return fines.filter((fine) => fine.createdAt < boundary);
}
