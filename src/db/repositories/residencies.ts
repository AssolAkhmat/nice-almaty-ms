import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';
import { addMonths, now, startOfMonth, type BusinessDate } from '@/lib/time';

import { assertHouseVisible, visibleHouseIds, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { closedPeriodLiteral, periodLiteral } from '../period';
import {
  bedAssignments,
  beds,
  residencies,
  type BedAssignment,
  type NewResidency,
  type Residency,
} from '../schema';

/**
 * Проживание и занятость мест.
 *
 * С этой таблицы начинается настоящая видимость жильцов для админа:
 * в фазе 1 её не было, и список жильцов дома оставался пустым (D11).
 */
function houseScope(context: AccessContext) {
  const visible = visibleHouseIds(context);

  if (visible === 'all') {
    return sql`true`;
  }

  return visible.length === 0 ? sql`false` : inArray(residencies.houseId, [...visible]);
}

/**
 * Жилец видит только своё проживание, админ — проживания своего дома.
 * Правило вынесено наружу: на нём же стоит видимость файлов и всего,
 * что прикрепляется к проживанию. Вторая копия правила однажды разойдётся
 * с первой, и разойдётся молча.
 */
export function residencyVisibility(context: AccessContext) {
  const byOrg = eq(residencies.orgId, context.orgId);

  return context.role === 'resident'
    ? and(byOrg, eq(residencies.userId, context.userId))
    : and(byOrg, houseScope(context));
}

export async function listResidencies(
  context: AccessContext,
  filter: { houseId?: string; status?: Residency['status']; userId?: string } = {},
  executor: Executor = getDb(),
): Promise<Residency[]> {
  const conditions = [residencyVisibility(context)];

  if (filter.houseId !== undefined) {
    assertHouseVisible(context, filter.houseId);
    conditions.push(eq(residencies.houseId, filter.houseId));
  }
  if (filter.userId !== undefined) {
    conditions.push(eq(residencies.userId, filter.userId));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(residencies.status, filter.status));
  }

  return executor
    .select()
    .from(residencies)
    .where(and(...conditions))
    .orderBy(desc(residencies.createdAt), desc(residencies.id));
}

export interface MonthStay {
  residencyId: string;
  userId: string;
  moveInDate: string | null;
  moveOutDate: string | null;
  /** Отрезки занятости мест ЭТОГО дома, пересекающиеся с месяцем. */
  periods: { from: BusinessDate; to: BusinessDate | null }[];
  /** В том же месяце у проживания было место в другом доме. */
  elsewhere: boolean;
}

/**
 * Кто занимал места дома в этом месяце (решение D26).
 *
 * Отличается от `listResidencies({ houseId })` тем, что смотрит на занятость
 * мест, а не на «дом сейчас»: переселившийся числится за новым домом, но
 * коммуналку старого дома за прожитые там дни платить обязан. Область
 * видимости — сам дом: кто стоял на местах дома, админ этого дома видит
 * и так, схемой мест.
 *
 * Другие дома наружу не называются: возвращается только признак «в этом
 * месяце было место и где-то ещё». Он нужен, чтобы отличить переселение
 * от обычного месяца, и больше ни для чего.
 */
export async function listMonthStaysInHouse(
  context: AccessContext,
  houseId: string,
  month: BusinessDate,
  executor: Executor = getDb(),
): Promise<MonthStay[]> {
  assertHouseVisible(context, houseId);

  const from = startOfMonth(month);
  const to = addMonths(from, 1);

  const overlapping = sql`${bedAssignments.period} && daterange(${from}::date, ${to}::date)`;

  const here = executor
    .select({ residencyId: bedAssignments.residencyId })
    .from(bedAssignments)
    .where(and(eq(bedAssignments.houseId, houseId), overlapping));

  const rows = await executor
    .select({
      residencyId: bedAssignments.residencyId,
      userId: residencies.userId,
      moveInDate: residencies.moveInDate,
      moveOutDate: residencies.moveOutDate,
      assignmentHouseId: bedAssignments.houseId,
      period: bedAssignments.period,
    })
    .from(bedAssignments)
    .innerJoin(residencies, eq(residencies.id, bedAssignments.residencyId))
    .where(
      and(
        eq(residencies.orgId, context.orgId),
        overlapping,
        /*
         * Два источника, и оба нужны. Первый — кто стоял на местах этого дома
         * в этом месяце: среди них есть уже переселившиеся, и дом они платить
         * обязаны. Второй — кто числится за домом сейчас: без него дом
         * не узнал бы, что в этом месяце человек стоял где-то ещё, и записал
         * бы себе весь месяц целиком.
         */
        or(inArray(bedAssignments.residencyId, here), eq(residencies.houseId, houseId)),
      ),
    );

  const byResidency = new Map<string, MonthStay>();

  for (const row of rows) {
    const stay = byResidency.get(row.residencyId) ?? {
      residencyId: row.residencyId,
      userId: row.userId,
      moveInDate: row.moveInDate,
      moveOutDate: row.moveOutDate,
      periods: [],
      elsewhere: false,
    };

    if (row.assignmentHouseId === houseId) {
      stay.periods.push(parsePeriod(row.period));
    } else {
      stay.elsewhere = true;
    }

    byResidency.set(row.residencyId, stay);
  }

  return [...byResidency.values()].sort((left, right) =>
    left.residencyId.localeCompare(right.residencyId),
  );
}

export interface HouseRosterEntry {
  residencyId: string;
  userId: string;
  /** Комната жильца сейчас; пусто — место не назначено (§8, режим «по комнате»). */
  areaId: string | null;
}

/**
 * Кто живёт в доме сейчас и в какой комнате — для деления ущерба (§8).
 *
 * Расторгающиеся входят наравне с действующими: §2.3 п.5 разрешает
 * проводить ущерб все 30 дней до возврата депозита. Архивные не входят:
 * их депозит уже разобран.
 */
export async function listHouseRoster(
  context: AccessContext,
  houseId: string,
  executor: Executor = getDb(),
): Promise<HouseRosterEntry[]> {
  assertHouseVisible(context, houseId);

  const rows = await executor
    .select({
      residencyId: residencies.id,
      userId: residencies.userId,
      areaId: beds.areaId,
    })
    .from(residencies)
    .leftJoin(
      bedAssignments,
      and(eq(bedAssignments.residencyId, residencies.id), sql`upper_inf(${bedAssignments.period})`),
    )
    .leftJoin(beds, eq(beds.id, bedAssignments.bedId))
    .where(
      and(
        residencyVisibility(context),
        eq(residencies.houseId, houseId),
        inArray(residencies.status, ['active', 'terminating']),
      ),
    )
    .orderBy(asc(residencies.createdAt), asc(residencies.id));

  return rows.map((row) => ({
    residencyId: row.residencyId,
    userId: row.userId,
    areaId: row.areaId,
  }));
}

export async function findResidency(
  context: AccessContext,
  residencyId: string,
  executor: Executor = getDb(),
): Promise<Residency | null> {
  const [residency] = await executor
    .select()
    .from(residencies)
    .where(and(residencyVisibility(context), eq(residencies.id, residencyId)))
    .limit(1);

  return residency ?? null;
}

export async function requireResidency(
  context: AccessContext,
  residencyId: string,
  executor: Executor = getDb(),
): Promise<Residency> {
  const residency = await findResidency(context, residencyId, executor);
  if (residency === null) {
    throw new NotFoundError('Проживание не найдено');
  }

  return residency;
}

export async function createResidency(
  context: AccessContext,
  input: Omit<NewResidency, 'orgId'>,
  executor: Executor = getDb(),
): Promise<Residency> {
  assertHouseVisible(context, input.houseId);

  const [residency] = await executor
    .insert(residencies)
    .values({ ...input, orgId: context.orgId })
    .returning();

  if (residency === undefined) {
    throw new Error('Проживание не создано');
  }

  return residency;
}

/**
 * Последний выданный номер договора года. Сортировка сперва по длине:
 * «2026-10000» лексикографически меньше «2026-9999», и без длины пятизначный
 * номер потерялся бы, а нумерация пошла бы по второму кругу (T8.1).
 */
export async function lastContractNumber(
  orgId: string,
  year: number,
  executor: Executor = getDb(),
): Promise<string | null> {
  const [row] = await executor
    .select({ number: residencies.contractNumber })
    .from(residencies)
    .where(and(eq(residencies.orgId, orgId), like(residencies.contractNumber, `${String(year)}-%`)))
    .orderBy(
      sql`length(${residencies.contractNumber}) desc`,
      desc(residencies.contractNumber),
      // Идентификатор в хвосте — правило устойчивого порядка списков (ordering.test.ts).
      desc(residencies.id),
    )
    .limit(1);

  return row?.number ?? null;
}

export async function updateResidency(
  context: AccessContext,
  residencyId: string,
  patch: Partial<Omit<NewResidency, 'id' | 'orgId'>>,
  executor: Executor = getDb(),
): Promise<Residency | null> {
  const [residency] = await executor
    .update(residencies)
    .set({ ...patch, updatedAt: now() })
    .where(and(residencyVisibility(context), eq(residencies.id, residencyId)))
    .returning();

  return residency ?? null;
}

/** Действующее назначение: то, у которого верхняя граница периода не задана. */
export async function findOpenAssignment(
  residencyId: string,
  executor: Executor = getDb(),
): Promise<BedAssignment | null> {
  const [assignment] = await executor
    .select()
    .from(bedAssignments)
    .where(
      and(eq(bedAssignments.residencyId, residencyId), sql`upper_inf(${bedAssignments.period})`),
    )
    .limit(1);

  return assignment ?? null;
}

/**
 * Действующее назначение на место, если оно занято сейчас.
 * Нужно настройке дома: занятое место не архивируется, иначе жилец
 * оказался бы в комнате, которой в схеме больше нет.
 */
export async function findOpenAssignmentOfBed(
  bedId: string,
  executor: Executor = getDb(),
): Promise<BedAssignment | null> {
  const [assignment] = await executor
    .select()
    .from(bedAssignments)
    .where(and(eq(bedAssignments.bedId, bedId), sql`upper_inf(${bedAssignments.period})`))
    .limit(1);

  return assignment ?? null;
}

/** Идентификаторы занятых сейчас мест дома — одной выборкой, а не по месту. */
export async function listOccupiedBedIds(
  houseId: string,
  executor: Executor = getDb(),
): Promise<string[]> {
  const rows = await executor
    .select({ bedId: bedAssignments.bedId })
    .from(bedAssignments)
    .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
    .where(and(eq(beds.houseId, houseId), sql`upper_inf(${bedAssignments.period})`));

  return rows.map((row) => row.bedId);
}

export async function listAssignments(
  residencyId: string,
  executor: Executor = getDb(),
): Promise<BedAssignment[]> {
  return executor
    .select()
    .from(bedAssignments)
    .where(eq(bedAssignments.residencyId, residencyId))
    .orderBy(desc(bedAssignments.createdAt), desc(bedAssignments.id));
}

/**
 * Назначает место с указанной даты. Прежнее назначение закрывается той же
 * датой, а не удаляется: история занятости должна сохраниться, и ограничение
 * исключения всё равно не позволило бы двум периодам пересечься.
 */
export async function assignBed(
  input: {
    residencyId: string;
    bedId: string;
    price: number;
    from: BusinessDate;
    createdBy?: string | null;
  },
  executor: Executor = getDb(),
): Promise<BedAssignment> {
  return executor.transaction(async (tx) => {
    const open = await findOpenAssignment(input.residencyId, tx);

    if (open !== null) {
      await tx
        .update(bedAssignments)
        .set({
          period: closedPeriodLiteral(parsePeriodStart(open.period), input.from),
          updatedAt: now(),
        })
        .where(eq(bedAssignments.id, open.id));
    }

    /*
     * Дом назначения берётся у самого места, а не у вызывающего: иначе
     * однажды его передадут неверно, и «дом тогда» разойдётся с местом.
     * Составной ключ такую строку и не примет, но лучше не давать ей
     * возникнуть вовсе.
     */
    const [bed] = await tx.select().from(beds).where(eq(beds.id, input.bedId)).limit(1);

    if (bed === undefined) {
      throw new NotFoundError('Место не найдено');
    }

    const [assignment] = await tx
      .insert(bedAssignments)
      .values({
        residencyId: input.residencyId,
        bedId: input.bedId,
        houseId: bed.houseId,
        price: input.price,
        period: periodLiteral({ from: input.from, to: null }),
        createdBy: input.createdBy ?? null,
      })
      .returning();

    if (assignment === undefined) {
      throw new Error('Место не назначено');
    }

    return assignment;
  });
}

/** Освобождает место с указанной даты, не удаляя историю. */
export async function releaseBed(
  residencyId: string,
  on: BusinessDate,
  executor: Executor = getDb(),
): Promise<void> {
  const open = await findOpenAssignment(residencyId, executor);
  if (open === null) {
    return;
  }

  await executor
    .update(bedAssignments)
    .set({
      period: closedPeriodLiteral(parsePeriodStart(open.period), on),
      updatedAt: now(),
    })
    .where(eq(bedAssignments.id, open.id));
}

/** Полуоткрытый интервал из литерала базы: `[2026-09-01,2026-10-01)`. */
function parsePeriod(literal: string): { from: BusinessDate; to: BusinessDate | null } {
  const match = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})?\)$/.exec(literal);

  if (match?.[1] === undefined) {
    throw new RangeError(`Не удалось прочитать период: ${literal}`);
  }

  return { from: match[1] as BusinessDate, to: (match[2] ?? null) as BusinessDate | null };
}

function parsePeriodStart(literal: string): BusinessDate {
  const start = /^\[(\d{4}-\d{2}-\d{2}),/.exec(literal)?.[1];

  if (start === undefined) {
    throw new RangeError(`Не удалось прочитать начало периода: ${literal}`);
  }

  return start as BusinessDate;
}
