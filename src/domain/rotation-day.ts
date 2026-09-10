import { compareBusinessDates, differenceInDays, type BusinessDate } from '@/lib/time';

/**
 * Ядро ротаций (`docs/tasks/PHASE-10.md` §2.3–§2.5, заменяет сетку §6.2).
 *
 * ```
 * состав(дата) = версия состава ряда, действующая на дату          -> S мест
 * норма(дата)  = версия нормы дня недели ряда, действующая на дату
 * duties       = зоны нормы по порядку, каждая повторена people раз -> D
 * L            = max(S, D)
 * vector       = duties ++ [ОТДЫХ] * (L - D)                        -> длина L
 * k            = floor( (дата - дата_старта_ряда) / 7 )             -> номер недели, с 0
 * позиция i (0..S-1) -> vector[ (i + k) mod L ]
 * ```
 *
 * Отличий от §6.2 два: зон может быть больше, чем людей (`D > S` — элементы вектора,
 * до которых не дотянулась ни одна позиция, становятся дырками «некого назначить»),
 * и списки версионируются датой вступления. Счётчик недель `k` считается от даты
 * старта ряда и сменой версии не сбрасывается: замена одного места другим на той же
 * позиции никого не двигает (уточнение владельца к умолчанию 1, P10-5).
 *
 * Функции чистые: ни БД, ни часов, ни истории исполнения. Отменённые
 * и перенесённые даты всё равно увеличивают `k` — сетка детерминирована.
 */

/** Зона нормы дня: чек-лист и число людей именно в этот день (§2.3). */
export interface DayNormZone {
  areaId: string;
  checklistId: string;
  /** Сколько человек убирает зону в этот день: столько мест вектора она и занимает. */
  people: number;
}

/** Что достаётся позиции состава на неделе: зона с чек-листом или отдых. */
export type RotationDuty =
  | { readonly kind: 'zone'; readonly areaId: string; readonly checklistId: string }
  | { readonly kind: 'rest' };

/** Любая версионированная запись: состав ряда или норма дня. */
export interface EffectiveDated {
  effectiveFrom: BusinessDate;
}

const DAYS_IN_WEEK = 7;

/**
 * Раскладывает зоны нормы по вектору и добивает остаток отдыхом.
 *
 * Длина вектора — `max(S, D)`, а не `S`: зона, не поместившаяся в состав,
 * не выбрасывается и не молчит, а становится дыркой «некого назначить» (§2.5).
 * Состав без мест (`S = 0`) — вырожденный, но допустимый случай: все зоны дня
 * остаются дырками и превращаются в задачи админу.
 */
export function dayVector(zones: readonly DayNormZone[], slotCount: number): RotationDuty[] {
  if (!Number.isInteger(slotCount) || slotCount < 0) {
    throw new RangeError(
      `Число мест в составе ряда должно быть целым и неотрицательным, задано: ${String(slotCount)}`,
    );
  }

  const duties: RotationDuty[] = [];

  for (const zone of zones) {
    if (!Number.isInteger(zone.people) || zone.people < 1) {
      throw new RangeError(
        `Число людей зоны ${zone.areaId} должно быть целым числом от единицы, задано: ${String(zone.people)}`,
      );
    }

    for (let repeat = 0; repeat < zone.people; repeat += 1) {
      duties.push({ kind: 'zone', areaId: zone.areaId, checklistId: zone.checklistId });
    }
  }

  while (duties.length < slotCount) {
    duties.push({ kind: 'rest' });
  }

  return duties;
}

/**
 * Номер недели ряда по дате занятия, с нуля.
 *
 * Дробная часть отбрасывается: занятие, перенесённое со среды на пятницу,
 * остаётся в своей неделе. Дата раньше старта ряда — ошибка: сетка до старта
 * не определена, и молчаливый отрицательный `k` дал бы правдоподобные,
 * но выдуманные назначения.
 */
export function weekIndex(rowStartDate: BusinessDate, date: BusinessDate): number {
  const days = differenceInDays(rowStartDate, date);

  if (days < 0) {
    throw new RangeError(`Дата ${date} раньше даты старта ряда (${rowStartDate})`);
  }

  return Math.floor(days / DAYS_IN_WEEK);
}

/**
 * Версия, действующая на дату: последняя из вступивших не позже неё.
 *
 * Список не обязан быть отсортированным — порядок в базе задаёт не дата,
 * а вставка. До первой версии действующей нет: это не пустой состав,
 * а отсутствие ответа, и решает его вызывающий.
 */
export function effectiveVersion<T extends EffectiveDated>(
  versions: readonly T[],
  date: BusinessDate,
): T | null {
  let current: T | null = null;

  for (const version of versions) {
    if (compareBusinessDates(version.effectiveFrom, date) > 0) {
      continue;
    }

    if (
      current === null ||
      compareBusinessDates(version.effectiveFrom, current.effectiveFrom) > 0
    ) {
      current = version;
    }
  }

  return current;
}

/** Версия состава ряда: места по порядку позиций (позиция привязана к месту, D12). */
export interface RosterVersion extends EffectiveDated {
  bedIds: readonly string[];
}

/** Версия нормы дня: зоны по порядку, у каждой чек-лист и число людей. */
export interface DayNormVersion extends EffectiveDated {
  zones: readonly DayNormZone[];
}

/** Почему у зоны нет исполнителя (§2.5). */
export type EmptySlotReason = 'empty_bed' | 'absent' | 'not_eligible' | 'no_one';

/** Одна зона одному человеку: зона с `people = 2` даёт два таких назначения. */
export interface PlannedAssignment {
  areaId: string;
  checklistId: string;
  /** Позиция состава, которой досталась зона; `null` — некого назначить. */
  position: number | null;
  bedId: string | null;
  userId: string | null;
  emptyReason: EmptySlotReason | null;
  /** Кто стоял в очереди на зону, но не допущен к ней (пометка §2.5). */
  queuedUserId: string | null;
}

/** Позиция состава, которой на этой неделе достался отдых. */
export interface RestingSlot {
  position: number;
  bedId: string;
  userId: string | null;
}

export interface DayPlanInput {
  /** Дата старта ряда: от неё считается `k`. */
  rowStartDate: BusinessDate;
  date: BusinessDate;
  rosters: readonly RosterVersion[];
  norms: readonly DayNormVersion[];
  /** Жилец места на дату; место без жильца — пустое. */
  occupants: Readonly<Record<string, string | null>>;
  /** Кто отсутствует на дату: одобренное отсутствие или болезнь (§6.3, §9). */
  absentUserIds?: readonly string[];
  /** Кого группа допуска пускает к зоне; зоны без записи пускают всех (§6.1). */
  eligibleByArea?: Readonly<Record<string, readonly string[]>>;
}

export interface DayPlan {
  /** Номер недели ряда, с нуля. */
  week: number;
  /** Назначения по порядку вектора: на неделе 0 это порядок зон нормы. */
  assignments: PlannedAssignment[];
  /** Кто отдыхает, по возрастанию позиции. */
  resting: RestingSlot[];
}

/**
 * План дня: кому какая зона досталась, кто отдыхает и где дырка.
 *
 * День недели ряда здесь не проверяется: какой ряд взять на дату, знает сервис —
 * ядро получает уже его состав и его норму.
 *
 * Выбывший участник (пустое место, отсутствие, недопуск) **не двигает остальных**:
 * его зона остаётся без исполнителя, цикл сохраняется, а дырку закрывает админ
 * вручную (P10-2). Недопуск проверяется здесь, при материализации, а не при
 * подборе вариантов обмена — иначе занятие до открытия дэшборда выглядело бы
 * укомплектованным, а шаблон текста §6.7 назвал бы недопущенного исполнителем (P10-4).
 */
export function dayPlan(input: DayPlanInput): DayPlan {
  const roster = effectiveVersion(input.rosters, input.date);

  if (roster === null) {
    throw new RangeError(`На дату ${input.date} нет действующей версии состава ряда`);
  }

  const norm = effectiveVersion(input.norms, input.date);

  if (norm === null) {
    throw new RangeError(`На дату ${input.date} нет действующей версии нормы дня`);
  }

  const week = weekIndex(input.rowStartDate, input.date);
  const beds = roster.bedIds;
  const vector = dayVector(norm.zones, beds.length);
  const absent = new Set(input.absentUserIds ?? []);
  const eligibleByArea = input.eligibleByArea ?? {};

  const assignments: PlannedAssignment[] = [];
  const resting: RestingSlot[] = [];

  vector.forEach((duty, index) => {
    // Обратная сторона формулы: позиция i получает vector[(i + k) mod L],
    // значит элемент вектора j достался позиции (j − k) mod L.
    const position = (((index - week) % vector.length) + vector.length) % vector.length;
    const bedId = position < beds.length ? beds[position] : undefined;

    if (duty.kind === 'rest') {
      if (bedId !== undefined) {
        resting.push({ position, bedId, userId: input.occupants[bedId] ?? null });
      }

      return;
    }

    const base = {
      areaId: duty.areaId,
      checklistId: duty.checklistId,
      queuedUserId: null,
    };

    if (bedId === undefined) {
      assignments.push({
        ...base,
        position: null,
        bedId: null,
        userId: null,
        emptyReason: 'no_one',
      });

      return;
    }

    const occupant = input.occupants[bedId] ?? null;

    if (occupant === null) {
      assignments.push({ ...base, position, bedId, userId: null, emptyReason: 'empty_bed' });

      return;
    }

    if (absent.has(occupant)) {
      assignments.push({ ...base, position, bedId, userId: null, emptyReason: 'absent' });

      return;
    }

    const allowed = eligibleByArea[duty.areaId];

    if (allowed !== undefined && !allowed.includes(occupant)) {
      assignments.push({
        ...base,
        position,
        bedId,
        userId: null,
        emptyReason: 'not_eligible',
        queuedUserId: occupant,
      });

      return;
    }

    assignments.push({ ...base, position, bedId, userId: occupant, emptyReason: null });
  });

  resting.sort((first, second) => first.position - second.position);

  return { week, assignments, resting };
}

/** Откуда взялся кандидат: долг, отдых в этот день, просто жилец дома (§2.8). */
export type CandidateSource = 'debt' | 'resting' | 'resident';

export interface ResolutionCandidate {
  userId: string;
  source: CandidateSource;
  /** Пускает ли группа допуска этого человека к зоне (§6.1). */
  eligible: boolean;
  /** Зоны, которые он уже убирает в этот же день: «уже на кухне». */
  busyAreaIds: string[];
}

export interface CandidatesInput {
  /** Зона, оставшаяся без исполнителя. */
  areaId: string;
  plan: DayPlan;
  /** Жильцы дома в порядке показа: порядок списка не должен прыгать. */
  residentUserIds: readonly string[];
  /** Баланс долга по доп. ротациям; должником делает только положительный (§2.7). */
  debtBalances?: Readonly<Record<string, number>>;
  absentUserIds?: readonly string[];
  eligibleByArea?: Readonly<Record<string, readonly string[]>>;
}

/** Один ход: перевести человека с его зоны на дырку, а на его зону — кандидата. */
export interface SwapOption {
  userId: string;
  fromAreaId: string;
  toAreaId: string;
  /** Кем закрыть освободившуюся зону: только допущенные к ней. */
  replacements: ResolutionCandidate[];
}

const SOURCE_ORDER: Record<CandidateSource, number> = { debt: 0, resting: 1, resident: 2 };

function isEligible(
  eligibleByArea: Readonly<Record<string, readonly string[]>> | undefined,
  areaId: string,
  userId: string,
): boolean {
  const allowed = eligibleByArea?.[areaId];

  return allowed === undefined || allowed.includes(userId);
}

/**
 * Кого предложить админу на зону без исполнителя (§2.8).
 *
 * Порядок групп задан §6.3: сначала должники, затем отдыхающие в этот день,
 * затем остальные жильцы дома. Внутри группы порядок жильцов дома сохраняется —
 * список читает человек, и он не должен переставляться от запроса к запросу.
 *
 * Недопущенный не исчезает, а помечается: админ вправе знать, кого система
 * не предлагает и почему. Отсутствующий исключается совсем — он не выйдет убирать.
 */
export function resolutionCandidates(input: CandidatesInput): ResolutionCandidate[] {
  const absent = new Set(input.absentUserIds ?? []);
  const debts = input.debtBalances ?? {};
  const resting = new Set(
    input.plan.resting
      .map((slot) => slot.userId)
      .filter((userId): userId is string => userId !== null),
  );

  const busyAreas = new Map<string, string[]>();

  for (const assignment of input.plan.assignments) {
    if (assignment.userId === null) {
      continue;
    }

    busyAreas.set(assignment.userId, [
      ...(busyAreas.get(assignment.userId) ?? []),
      assignment.areaId,
    ]);
  }

  const seen = new Set<string>();
  const candidates: ResolutionCandidate[] = [];

  for (const userId of input.residentUserIds) {
    if (absent.has(userId) || seen.has(userId)) {
      continue;
    }

    seen.add(userId);

    const source: CandidateSource =
      (debts[userId] ?? 0) > 0 ? 'debt' : resting.has(userId) ? 'resting' : 'resident';

    candidates.push({
      userId,
      source,
      eligible: isEligible(input.eligibleByArea, input.areaId, userId),
      busyAreaIds: busyAreas.get(userId) ?? [],
    });
  }

  // Сортировка устойчивая: внутри группы остаётся порядок жильцов дома.
  return candidates.sort(
    (first, second) => SOURCE_ORDER[first.source] - SOURCE_ORDER[second.source],
  );
}

/**
 * Обмены в один ход для зоны без исполнителя (§2.8).
 *
 * Меняться могут только занятые в этот день и только те, кого группа допуска
 * пускает к самой дырке. Своя зона в обмен не предлагается: у зоны на двоих,
 * где выбыл один, перевод второго с неё на неё же ничего не меняет.
 *
 * Ничего не сохраняется: выбор админа становится обычной правкой недели (§2.6).
 */
export function swapOptions(input: CandidatesInput): SwapOption[] {
  const options: SwapOption[] = [];
  const seen = new Set<string>();

  for (const assignment of input.plan.assignments) {
    const { userId, areaId } = assignment;

    if (userId === null || areaId === input.areaId) {
      continue;
    }

    if (!isEligible(input.eligibleByArea, input.areaId, userId)) {
      continue;
    }

    const key = `${userId} ${areaId}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    options.push({
      userId,
      fromAreaId: areaId,
      toAreaId: input.areaId,
      replacements: resolutionCandidates({ ...input, areaId }).filter(
        (candidate) => candidate.eligible && candidate.userId !== userId,
      ),
    });
  }

  return options;
}
