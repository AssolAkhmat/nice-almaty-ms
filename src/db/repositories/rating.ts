import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { now, type BusinessDate } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import {
  absences,
  discounts,
  fines,
  ratingEvents,
  ratingRules,
  ratingThresholdStates,
  residencies,
  users,
  type Absence,
  type Discount,
  type Fine,
  type RatingEvent,
  type RatingRule,
  type RatingThresholdState,
} from '../schema';

/**
 * Отсутствия, рейтинг, штрафы и скидки (docs/02-DATA-MODEL.md).
 *
 * Жилец видит своё, админ — свой дом, суперадмин — сеть. Связь жильца с домом
 * идёт через проживание: колонки дома у него нет (D11).
 */
function houseScope(
  context: AccessContext,
  column: typeof absences.houseId | typeof fines.houseId,
) {
  if (context.role === 'resident') {
    return sql`exists (
      select 1 from ${residencies}
      where ${residencies.userId} = ${context.userId}
        and ${residencies.houseId} = ${column}
    )`;
  }

  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return sql`true`;
  }

  return visible.length === 0 ? sql`false` : inArray(column, [...visible]);
}

/** Жилец видит только своё; остальные — по дому. */
function ownScope(context: AccessContext, column: typeof absences.userId) {
  return context.role === 'resident' ? eq(column, context.userId) : sql`true`;
}

export interface CreateAbsenceInput {
  userId: string;
  houseId: string;
  type: 'short' | 'long' | 'sick';
  startDate: BusinessDate;
  endDate?: BusinessDate | null;
  startAt?: Date | null;
  reason: string;
  docFileId?: string | null;
}

export async function createAbsence(
  context: AccessContext,
  input: CreateAbsenceInput,
  executor: Executor = getDb(),
): Promise<Absence> {
  const [absence] = await executor
    .insert(absences)
    .values({
      orgId: context.orgId,
      userId: input.userId,
      houseId: input.houseId,
      type: input.type,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      startAt: input.startAt ?? null,
      reason: input.reason,
      docFileId: input.docFileId ?? null,
    })
    .returning();

  if (absence === undefined) {
    throw new Error('Отсутствие не создано');
  }

  return absence;
}

export interface AbsenceFilter {
  houseId?: string;
  userId?: string;
  status?: 'pending' | 'approved' | 'rejected';
  type?: 'short' | 'long' | 'sick';
}

export async function listAbsences(
  context: AccessContext,
  filter: AbsenceFilter = {},
  executor: Executor = getDb(),
): Promise<Absence[]> {
  const conditions = [
    eq(absences.orgId, context.orgId),
    houseScope(context, absences.houseId),
    ownScope(context, absences.userId),
  ];

  if (filter.houseId !== undefined) {
    conditions.push(eq(absences.houseId, filter.houseId));
  }

  if (filter.userId !== undefined) {
    conditions.push(eq(absences.userId, filter.userId));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(absences.status, filter.status));
  }

  if (filter.type !== undefined) {
    conditions.push(eq(absences.type, filter.type));
  }

  return executor
    .select()
    .from(absences)
    .where(and(...conditions))
    .orderBy(asc(absences.startDate), asc(absences.id));
}

export async function requireAbsence(
  context: AccessContext,
  absenceId: string,
  executor: Executor = getDb(),
): Promise<Absence> {
  const [absence] = await executor
    .select()
    .from(absences)
    .where(
      and(
        eq(absences.id, absenceId),
        eq(absences.orgId, context.orgId),
        houseScope(context, absences.houseId),
        ownScope(context, absences.userId),
      ),
    )
    .limit(1);

  if (absence === undefined) {
    throw new NotFoundError('Отсутствие не найдено');
  }

  return absence;
}

export interface UpdateAbsenceInput {
  status?: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
  reviewNote?: string | null;
  endDate?: BusinessDate | null;
}

export async function updateAbsence(
  context: AccessContext,
  absenceId: string,
  patch: UpdateAbsenceInput,
  executor: Executor = getDb(),
): Promise<Absence> {
  await requireAbsence(context, absenceId, executor);

  const [absence] = await executor
    .update(absences)
    .set({ ...patch, updatedAt: now() })
    .where(eq(absences.id, absenceId))
    .returning();

  if (absence === undefined) {
    throw new NotFoundError('Отсутствие не найдено');
  }

  return absence;
}

/**
 * Одобренные отсутствия дома, пересекающиеся с периодом.
 *
 * Читают их коммуналка и расписание ротаций, поэтому проверка права идёт
 * по самой операции, а не по разделу отсутствий: расчёт коммуналки делает
 * тот, кто вправе её считать (P3-1).
 */
export async function listApprovedAbsences(
  context: AccessContext,
  houseId: string,
  range: { from: BusinessDate; to: BusinessDate },
  executor: Executor = getDb(),
): Promise<Absence[]> {
  return executor
    .select()
    .from(absences)
    .where(
      and(
        eq(absences.orgId, context.orgId),
        eq(absences.houseId, houseId),
        eq(absences.status, 'approved'),
        sql`${absences.startDate} <= ${range.to}::date`,
        sql`coalesce(${absences.endDate}, ${absences.startDate}) >= ${range.from}::date`,
      ),
    )
    .orderBy(asc(absences.startDate), asc(absences.id));
}

export interface RatingRuleInput {
  /** `null` — правило сети; дом переопределяет его по тому же коду (§5.5). */
  houseId: string | null;
  kind: 'score_delta' | 'admin_action' | 'threshold_down' | 'threshold_up';
  code: string;
  config: unknown;
  isActive?: boolean;
}

export async function putRatingRule(
  context: AccessContext,
  input: RatingRuleInput,
  executor: Executor = getDb(),
): Promise<RatingRule> {
  if (input.houseId !== null) {
    assertHouseVisible(context, input.houseId);
  }

  const values = {
    orgId: context.orgId,
    houseId: input.houseId,
    kind: input.kind,
    code: input.code,
    config: input.config,
    isActive: input.isActive ?? true,
  };

  const set = {
    kind: input.kind,
    config: input.config,
    isActive: input.isActive ?? true,
    updatedAt: now(),
  };

  /*
   * Цель конфликта своя у каждого уровня: правило сети уникально по коду
   * при пустом доме, правило дома — по коду вместе с домом. Обе цели —
   * частичные индексы, поэтому условие приходится называть явно.
   */
  const [rule] =
    input.houseId === null
      ? await executor
          .insert(ratingRules)
          .values(values)
          .onConflictDoUpdate({
            target: [ratingRules.orgId, ratingRules.code],
            targetWhere: isNull(ratingRules.houseId),
            set,
          })
          .returning()
      : await executor
          .insert(ratingRules)
          .values(values)
          .onConflictDoUpdate({
            target: [ratingRules.orgId, ratingRules.houseId, ratingRules.code],
            targetWhere: isNotNull(ratingRules.houseId),
            set,
          })
          .returning();

  if (rule === undefined) {
    throw new Error('Правило рейтинга не сохранено');
  }

  return rule;
}

/**
 * Правило, если его ещё нет: пороги §5.3–5.4 должны существовать строкой,
 * иначе состоянию порога и скидке не на что сослаться.
 *
 * Отличается от `putRatingRule` тем, что чужую правку не затирает: правила
 * редактирует суперадмин, и умолчание не вправе возвращаться поверх него.
 */
export async function ensureRatingRule(
  context: AccessContext,
  input: RatingRuleInput,
  executor: Executor = getDb(),
): Promise<RatingRule> {
  const existing = await listRatingRules(
    context,
    input.houseId === null ? { networkOnly: true } : { houseId: input.houseId },
    executor,
  );
  const found = existing.find((rule) => rule.code === input.code);

  if (found !== undefined) {
    return found;
  }

  return putRatingRule(context, input, executor);
}

export interface RatingRuleFilter {
  /** Дом: отдаёт только его переопределения. Без него — вся сеть. */
  houseId?: string;
  kind?: 'score_delta' | 'admin_action' | 'threshold_down' | 'threshold_up';
  /** Правила сети: `house_id is null`. */
  networkOnly?: boolean;
}

export async function listRatingRules(
  context: AccessContext,
  filter: RatingRuleFilter = {},
  executor: Executor = getDb(),
): Promise<RatingRule[]> {
  const conditions = [eq(ratingRules.orgId, context.orgId)];

  if (filter.houseId !== undefined) {
    assertHouseVisible(context, filter.houseId);
    conditions.push(eq(ratingRules.houseId, filter.houseId));
  }

  if (filter.networkOnly === true) {
    conditions.push(isNull(ratingRules.houseId));
  }

  if (filter.kind !== undefined) {
    conditions.push(eq(ratingRules.kind, filter.kind));
  }

  return executor
    .select()
    .from(ratingRules)
    .where(and(...conditions))
    .orderBy(asc(ratingRules.kind), asc(ratingRules.code), asc(ratingRules.id));
}

export interface CreateRatingEventInput {
  userId: string;
  type: string;
  delta: number;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
  effectiveAt?: Date;
  periodStart: BusinessDate;
}

export async function createRatingEvent(
  context: AccessContext,
  input: CreateRatingEventInput,
  executor: Executor = getDb(),
): Promise<RatingEvent> {
  const [event] = await executor
    .insert(ratingEvents)
    .values({
      orgId: context.orgId,
      userId: input.userId,
      type: input.type,
      delta: input.delta,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      note: input.note ?? null,
      createdBy: context.userId,
      ...(input.effectiveAt === undefined ? {} : { effectiveAt: input.effectiveAt }),
      periodStart: input.periodStart,
    })
    .returning();

  if (event === undefined) {
    throw new Error('Событие рейтинга не создано');
  }

  return event;
}

/**
 * Событие по ссылке: одно на назначение ротации (§7).
 *
 * Админ правит оценку задним числом, и второе событие на ту же уборку
 * начислило бы дельту дважды. Ограничение уникальности превращает повтор
 * в правку — той же строки, с той же датой года.
 */
export async function putRefRatingEvent(
  context: AccessContext,
  input: CreateRatingEventInput & { refType: string; refId: string },
  executor: Executor = getDb(),
): Promise<RatingEvent> {
  const [event] = await executor
    .insert(ratingEvents)
    .values({
      orgId: context.orgId,
      userId: input.userId,
      type: input.type,
      delta: input.delta,
      refType: input.refType,
      refId: input.refId,
      note: input.note ?? null,
      createdBy: context.userId,
      ...(input.effectiveAt === undefined ? {} : { effectiveAt: input.effectiveAt }),
      periodStart: input.periodStart,
    })
    .onConflictDoUpdate({
      target: [ratingEvents.userId, ratingEvents.refType, ratingEvents.refId],
      targetWhere: isNotNull(ratingEvents.refId),
      set: {
        type: input.type,
        delta: input.delta,
        note: input.note ?? null,
        createdBy: context.userId,
        periodStart: input.periodStart,
        ...(input.effectiveAt === undefined ? {} : { effectiveAt: input.effectiveAt }),
      },
    })
    .returning();

  if (event === undefined) {
    throw new Error('Событие рейтинга не создано');
  }

  return event;
}

export interface RatingEventFilter {
  userId: string;
  periodStart?: BusinessDate;
}

/**
 * События жильца за год рейтинга.
 *
 * Видимость идёт через проживание: админ читает историю тех, кто живёт
 * в его доме, жилец — только свою (§5.6).
 */
export async function listRatingEvents(
  context: AccessContext,
  filter: RatingEventFilter,
  executor: Executor = getDb(),
): Promise<RatingEvent[]> {
  const conditions = [
    eq(ratingEvents.orgId, context.orgId),
    eq(ratingEvents.userId, filter.userId),
    userVisibility(context),
  ];

  if (filter.periodStart !== undefined) {
    conditions.push(eq(ratingEvents.periodStart, filter.periodStart));
  }

  return executor
    .select()
    .from(ratingEvents)
    .where(and(...conditions))
    .orderBy(asc(ratingEvents.effectiveAt), asc(ratingEvents.id));
}

/** Кого контекст вправе видеть: себя, жильцов своего дома или всю сеть. */
function userVisibility(context: AccessContext) {
  if (context.role === 'superadmin') {
    return sql`true`;
  }

  if (context.role === 'resident') {
    return eq(ratingEvents.userId, context.userId);
  }

  const visible = visibleHouseIds(context);

  if (visible === 'all' || visible.length === 0) {
    return visible === 'all' ? sql`true` : sql`false`;
  }

  return sql`exists (
    select 1 from ${residencies}
    where ${residencies.userId} = ${ratingEvents.userId}
      and ${residencies.houseId} in ${visible}
  )`;
}

/**
 * Состояния порогов лежат в таблице без `org_id`: ключ там — пара
 * «жилец и правило». Сеть у них всё равно есть — та, в которой числится
 * жилец, — и запрос обязан её проверять (CLAUDE.md §3). Без этого пороги
 * читались бы по одному лишь идентификатору человека из чужой сети:
 * тот же класс дефекта, что инцидент I6.
 */
function inNetwork(context: AccessContext) {
  return sql`exists (
    select 1 from ${users}
    where ${users.id} = ${ratingThresholdStates.userId}
      and ${users.orgId} = ${context.orgId}
  )`;
}

export interface ThresholdStateInput {
  ruleId: string;
  armed: boolean;
  lastTriggeredAt?: Date | null;
}

export async function writeThresholdStates(
  context: AccessContext,
  userId: string,
  states: readonly ThresholdStateInput[],
  executor: Executor = getDb(),
): Promise<void> {
  if (states.length === 0) {
    return;
  }

  const [addressee] = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, context.orgId)))
    .limit(1);

  if (addressee === undefined) {
    throw new NotFoundError('Жилец не найден');
  }

  for (const state of states) {
    await executor
      .insert(ratingThresholdStates)
      .values({
        userId,
        ruleId: state.ruleId,
        armed: state.armed,
        lastTriggeredAt: state.lastTriggeredAt ?? null,
      })
      .onConflictDoUpdate({
        target: [ratingThresholdStates.userId, ratingThresholdStates.ruleId],
        set: {
          armed: state.armed,
          ...(state.lastTriggeredAt === undefined
            ? {}
            : { lastTriggeredAt: state.lastTriggeredAt }),
          updatedAt: now(),
        },
      });
  }
}

export async function readThresholdStates(
  context: AccessContext,
  userId: string,
  executor: Executor = getDb(),
): Promise<RatingThresholdState[]> {
  return executor
    .select()
    .from(ratingThresholdStates)
    .where(and(eq(ratingThresholdStates.userId, userId), inNetwork(context)))
    .orderBy(asc(ratingThresholdStates.ruleId), asc(ratingThresholdStates.id));
}

export interface CreateFineInput {
  userId: string;
  houseId: string;
  amount: number;
  reason: string;
  ruleId?: string | null;
}

export async function createFine(
  context: AccessContext,
  input: CreateFineInput,
  executor: Executor = getDb(),
): Promise<Fine> {
  assertHouseVisible(context, input.houseId);

  const [fine] = await executor
    .insert(fines)
    .values({
      orgId: context.orgId,
      userId: input.userId,
      houseId: input.houseId,
      amount: input.amount,
      reason: input.reason,
      ruleId: input.ruleId ?? null,
      createdBy: context.userId,
    })
    .returning();

  if (fine === undefined) {
    throw new Error('Штраф не создан');
  }

  return fine;
}

export interface FineFilter {
  houseId?: string;
  userId?: string;
  status?: 'pending' | 'applied' | 'cancelled';
}

export async function listFines(
  context: AccessContext,
  filter: FineFilter = {},
  executor: Executor = getDb(),
): Promise<Fine[]> {
  const conditions = [eq(fines.orgId, context.orgId), houseScope(context, fines.houseId)];

  if (filter.houseId !== undefined) {
    conditions.push(eq(fines.houseId, filter.houseId));
  }

  if (filter.userId !== undefined) {
    conditions.push(eq(fines.userId, filter.userId));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(fines.status, filter.status));
  }

  return executor
    .select()
    .from(fines)
    .where(and(...conditions))
    .orderBy(asc(fines.createdAt), asc(fines.id));
}

export interface UpdateFineInput {
  status?: 'pending' | 'applied' | 'cancelled';
  invoiceId?: string | null;
  cancelledBy?: string | null;
  cancelledReason?: string | null;
}

export async function updateFine(
  context: AccessContext,
  fineId: string,
  patch: UpdateFineInput,
  executor: Executor = getDb(),
): Promise<Fine> {
  const [existing] = await executor
    .select()
    .from(fines)
    .where(
      and(eq(fines.id, fineId), eq(fines.orgId, context.orgId), houseScope(context, fines.houseId)),
    )
    .limit(1);

  if (existing === undefined) {
    throw new NotFoundError('Штраф не найден');
  }

  const [fine] = await executor
    .update(fines)
    .set({ ...patch, updatedAt: now() })
    .where(eq(fines.id, fineId))
    .returning();

  if (fine === undefined) {
    throw new NotFoundError('Штраф не найден');
  }

  return fine;
}

export interface CreateDiscountInput {
  userId: string;
  amount: number;
  ruleId: string;
}

export async function createDiscount(
  context: AccessContext,
  input: CreateDiscountInput,
  executor: Executor = getDb(),
): Promise<Discount> {
  const [discount] = await executor
    .insert(discounts)
    .values({
      orgId: context.orgId,
      userId: input.userId,
      amount: input.amount,
      ruleId: input.ruleId,
    })
    .returning();

  if (discount === undefined) {
    throw new Error('Скидка не создана');
  }

  return discount;
}

export async function listDiscounts(
  context: AccessContext,
  filter: { userId?: string; status?: 'proposed' | 'approved' | 'revoked' } = {},
  executor: Executor = getDb(),
): Promise<Discount[]> {
  const conditions = [eq(discounts.orgId, context.orgId)];

  if (filter.userId !== undefined) {
    conditions.push(eq(discounts.userId, filter.userId));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(discounts.status, filter.status));
  }

  return executor
    .select()
    .from(discounts)
    .where(and(...conditions))
    .orderBy(asc(discounts.createdAt), asc(discounts.id));
}

export interface UpdateDiscountInput {
  status?: 'proposed' | 'approved' | 'revoked';
  approvedBy?: string | null;
  approvedAt?: Date | null;
}

export async function updateDiscount(
  context: AccessContext,
  discountId: string,
  patch: UpdateDiscountInput,
  executor: Executor = getDb(),
): Promise<Discount> {
  const [discount] = await executor
    .update(discounts)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(discounts.id, discountId), eq(discounts.orgId, context.orgId)))
    .returning();

  if (discount === undefined) {
    throw new NotFoundError('Скидка не найдена');
  }

  return discount;
}
