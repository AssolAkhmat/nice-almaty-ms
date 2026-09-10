import { describe, expect, it } from 'vitest';

import { parseBusinessDate, type BusinessDate } from '@/lib/time';

import {
  dayPlan,
  dayVector,
  effectiveVersion,
  weekIndex,
  type DayNormVersion,
  type DayNormZone,
  type DayPlan,
  type DayPlanInput,
  resolutionCandidates,
  swapOptions,
  type CandidatesInput,
  type RosterVersion,
  type RotationDuty,
} from './rotation-day';

/**
 * Ядро ротаций фазы 10: состав ряда и норма дня на дату дают вектор обязанностей.
 * Числовые примеры — `docs/tasks/PHASE-10.md` §3, на числах владельца.
 * Функции чистые: ни БД, ни часов, ни истории исполнения.
 */

/** Среда первой недели примера: с неё стартуют ряды. */
const WEDNESDAY = parseBusinessDate('2026-09-09');

/** Воскресенье первой недели примера. */
const SUNDAY = parseBusinessDate('2026-09-13');

function zone(areaId: string, people = 1): DayNormZone {
  return { areaId, checklistId: `checklist-${areaId}`, people };
}

/** Короткая запись обязанности: имя зоны или «отдых». */
function label(duty: RotationDuty): string {
  return duty.kind === 'rest' ? 'отдых' : duty.areaId;
}

/** Норма среды и пятницы: четыре зоны по одному человеку. */
const WEEKDAY_ZONES: DayNormZone[] = [
  zone('kitchen'),
  zone('bathroom'),
  zone('corridor'),
  zone('hall'),
];

/** Норма воскресенья: двор на двоих плюс пять зон по одному. */
const SUNDAY_ZONES: DayNormZone[] = [
  zone('yard', 2),
  zone('fridge'),
  zone('kitchen'),
  zone('bathroom'),
  zone('corridor'),
  zone('hall'),
];

describe('вектор дня', () => {
  it('людей столько же, сколько зон: вектор — сами зоны, отдыха нет', () => {
    expect(dayVector(SUNDAY_ZONES, 7).map(label)).toEqual([
      'yard',
      'yard',
      'fridge',
      'kitchen',
      'bathroom',
      'corridor',
      'hall',
    ]);
  });

  it('людей больше, чем зон: остаток добивается отдыхом до числа мест', () => {
    expect(dayVector(WEEKDAY_ZONES, 6).map(label)).toEqual([
      'kitchen',
      'bathroom',
      'corridor',
      'hall',
      'отдых',
      'отдых',
    ]);
  });

  it('зон больше, чем людей: вектор длиннее состава, отдыха в нём нет', () => {
    const vector = dayVector([...SUNDAY_ZONES, zone('veranda')], 7);

    expect(vector).toHaveLength(8);
    expect(vector.map(label).at(-1)).toBe('veranda');
    expect(vector.some((duty) => duty.kind === 'rest')).toBe(false);
  });

  it('состав без мест: все зоны остаются в векторе и никому не достаются', () => {
    expect(dayVector(WEEKDAY_ZONES, 0).map(label)).toEqual([
      'kitchen',
      'bathroom',
      'corridor',
      'hall',
    ]);
  });

  it('число людей зоны меньше единицы — ошибка, а не молчаливый пропуск зоны', () => {
    expect(() => dayVector([zone('yard', 0)], 4)).toThrow(RangeError);
  });

  it('отрицательное число мест — ошибка', () => {
    expect(() => dayVector(WEEKDAY_ZONES, -1)).toThrow(RangeError);
  });
});

describe('номер недели ряда', () => {
  it('считается от даты старта ряда, с нуля', () => {
    expect(weekIndex(WEDNESDAY, WEDNESDAY)).toBe(0);
    expect(weekIndex(WEDNESDAY, parseBusinessDate('2026-09-16'))).toBe(1);
    expect(weekIndex(WEDNESDAY, parseBusinessDate('2026-10-07'))).toBe(4);
  });

  it('перенос внутри недели не меняет номер: дробная часть отбрасывается', () => {
    expect(weekIndex(WEDNESDAY, parseBusinessDate('2026-09-11'))).toBe(0);
  });

  it('дата раньше старта ряда — ошибка, а не отрицательная неделя', () => {
    expect(() => weekIndex(WEDNESDAY, parseBusinessDate('2026-09-08'))).toThrow(RangeError);
  });
});

describe('версия на дату', () => {
  const versions = [
    { effectiveFrom: parseBusinessDate('2026-09-09'), name: 'первая' },
    { effectiveFrom: parseBusinessDate('2026-10-15'), name: 'вторая' },
  ];

  it('берётся последняя, вступившая не позже даты', () => {
    expect(effectiveVersion(versions, parseBusinessDate('2026-10-14'))?.name).toBe('первая');
    expect(effectiveVersion(versions, parseBusinessDate('2026-10-15'))?.name).toBe('вторая');
    expect(effectiveVersion(versions, parseBusinessDate('2026-12-31'))?.name).toBe('вторая');
  });

  it('порядок в списке не важен: версии сравниваются по дате вступления', () => {
    expect(effectiveVersion([...versions].reverse(), parseBusinessDate('2026-10-20'))?.name).toBe(
      'вторая',
    );
  });

  it('до первой версии действующей нет', () => {
    expect(effectiveVersion(versions, parseBusinessDate('2026-09-08'))).toBeNull();
  });
});

/**
 * План дня целиком: кому что достаётся, где отдых, где дырка.
 * Числа — пример владельца из `docs/tasks/PHASE-10.md` §3.
 */

/** Состав среды: четыре места, по одному на жильца. */
const WEDNESDAY_BEDS = ['A', 'B', 'C', 'D'];

/** Состав воскресенья: семеро своих, а не весь дом (P10-1). */
const SUNDAY_BEDS = ['I', 'J', 'K', 'L', 'M', 'N', 'O'];

/** Жилец места: в примере на каждом месте свой человек. */
function occupantsOf(beds: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(beds.map((bed) => [bed, `user-${bed}`]));
}

function roster(effectiveFrom: BusinessDate, bedIds: readonly string[]): RosterVersion {
  return { effectiveFrom, bedIds };
}

function norm(effectiveFrom: BusinessDate, zones: readonly DayNormZone[]): DayNormVersion {
  return { effectiveFrom, zones };
}

/** Запись назначения для сравнения: зона и кто её убирает. */
function assigned(plan: DayPlan): string[] {
  return plan.assignments.map(
    (item) => `${item.areaId}:${item.userId ?? `нет (${item.emptyReason ?? 'без причины'})`}`,
  );
}

/** Всех, кто без исполнителя, — по порядку вектора. */
function holes(plan: DayPlan) {
  return plan.assignments.filter((item) => item.userId === null);
}

function wednesdayPlan(date: BusinessDate, extra: Partial<DayPlanInput> = {}): DayPlan {
  return dayPlan({
    rowStartDate: WEDNESDAY,
    date,
    rosters: [roster(WEDNESDAY, WEDNESDAY_BEDS)],
    norms: [norm(WEDNESDAY, WEEKDAY_ZONES)],
    occupants: occupantsOf(WEDNESDAY_BEDS),
    ...extra,
  });
}

function sundayPlan(date: BusinessDate, extra: Partial<DayPlanInput> = {}): DayPlan {
  return dayPlan({
    rowStartDate: SUNDAY,
    date,
    rosters: [roster(SUNDAY, SUNDAY_BEDS)],
    norms: [norm(SUNDAY, SUNDAY_ZONES)],
    occupants: occupantsOf(SUNDAY_BEDS),
    ...extra,
  });
}

/** Двор без J: «двор — парни, кроме Азамата» из §6.1. */
const YARD_WITHOUT_J = {
  yard: SUNDAY_BEDS.filter((bed) => bed !== 'J').map((bed) => `user-${bed}`),
};

describe('план дня: пример владельца', () => {
  it('среда, неделя 0: четверо на четырёх зонах по порядку нормы', () => {
    const plan = wednesdayPlan(WEDNESDAY);

    expect(plan.week).toBe(0);
    expect(assigned(plan)).toEqual([
      'kitchen:user-A',
      'bathroom:user-B',
      'corridor:user-C',
      'hall:user-D',
    ]);
  });

  it('среда, неделя 1: зоны сдвинулись на шаг, состав тот же', () => {
    const plan = wednesdayPlan(parseBusinessDate('2026-09-16'));

    expect(plan.week).toBe(1);
    expect(assigned(plan)).toEqual([
      'kitchen:user-D',
      'bathroom:user-A',
      'corridor:user-B',
      'hall:user-C',
    ]);
  });

  it('воскресенье, неделя 0: двор на двоих, отдыха нет', () => {
    const plan = sundayPlan(SUNDAY);

    expect(assigned(plan)).toEqual([
      'yard:user-I',
      'yard:user-J',
      'fridge:user-K',
      'kitchen:user-L',
      'bathroom:user-M',
      'corridor:user-N',
      'hall:user-O',
    ]);
    expect(plan.resting).toEqual([]);
  });

  it('воскресенье, неделя 1: зоны сдвинулись, двор снова на двоих', () => {
    expect(assigned(sundayPlan(parseBusinessDate('2026-09-20')))).toEqual([
      'yard:user-O',
      'yard:user-I',
      'fridge:user-J',
      'kitchen:user-K',
      'bathroom:user-L',
      'corridor:user-M',
      'hall:user-N',
    ]);
  });

  it('людей больше, чем зон: лишние отдыхают, а не получают чужую зону', () => {
    const beds = [...WEDNESDAY_BEDS, 'P', 'Q'];
    const plan = wednesdayPlan(WEDNESDAY, {
      rosters: [roster(WEDNESDAY, beds)],
      occupants: occupantsOf(beds),
    });

    expect(plan.resting).toEqual([
      { position: 4, bedId: 'P', userId: 'user-P' },
      { position: 5, bedId: 'Q', userId: 'user-Q' },
    ]);
  });
});

describe('план дня: заселение двоих правит состав и норму с даты', () => {
  // Неделя вступления — шестая, а не пятая: на пятой сдвиг кратен длине вектора,
  // и расклад совпал бы со сброшенным счётчиком — тест ничего бы не доказывал.
  const CHANGE = parseBusinessDate('2026-10-21');
  const WITH_VERANDA = [...WEEKDAY_ZONES, zone('veranda')];

  function planAt(date: BusinessDate): DayPlan {
    return wednesdayPlan(date, {
      rosters: [roster(WEDNESDAY, WEDNESDAY_BEDS), roster(CHANGE, [...WEDNESDAY_BEDS, 'P'])],
      norms: [norm(WEDNESDAY, WEEKDAY_ZONES), norm(CHANGE, WITH_VERANDA)],
      occupants: occupantsOf([...WEDNESDAY_BEDS, 'P']),
    });
  }

  it('до даты вступления действует прежний состав из четверых', () => {
    expect(assigned(planAt(parseBusinessDate('2026-10-07')))).toHaveLength(4);
  });

  it('с даты вступления в ряду пятеро и пять зон', () => {
    expect(assigned(planAt(CHANGE))).toHaveLength(5);
  });

  it('счётчик недель не сбрасывается сменой версии: неделя считается от старта ряда', () => {
    const plan = planAt(CHANGE);

    expect(plan.week).toBe(6);
    expect(assigned(plan)).toEqual([
      'kitchen:user-P',
      'bathroom:user-A',
      'corridor:user-B',
      'hall:user-C',
      'veranda:user-D',
    ]);
  });

  it('на дату раньше первой версии состава плана нет', () => {
    expect(() => wednesdayPlan(WEDNESDAY, { rosters: [roster(CHANGE, WEDNESDAY_BEDS)] })).toThrow(
      RangeError,
    );
  });

  it('на дату раньше первой версии нормы плана нет', () => {
    expect(() => wednesdayPlan(WEDNESDAY, { norms: [norm(CHANGE, WEEKDAY_ZONES)] })).toThrow(
      RangeError,
    );
  });
});

describe('план дня: дырки', () => {
  const WITH_VERANDA = [...SUNDAY_ZONES, zone('veranda')];

  function withVeranda(date: BusinessDate): DayPlan {
    return sundayPlan(date, { norms: [norm(SUNDAY, WITH_VERANDA)] });
  }

  it('зон больше, чем людей: на первой неделе без исполнителя веранда', () => {
    const empty = holes(withVeranda(SUNDAY));

    expect(empty).toHaveLength(1);
    expect(empty[0]?.areaId).toBe('veranda');
    expect(empty[0]?.emptyReason).toBe('no_one');
    expect(empty[0]?.position).toBeNull();
  });

  it('дырка ходит по кругу вместе с зонами, остальные на местах', () => {
    const secondWeek = withVeranda(parseBusinessDate('2026-09-20'));
    const thirdWeek = withVeranda(parseBusinessDate('2026-09-27'));

    expect(holes(secondWeek)).toHaveLength(1);
    expect(holes(secondWeek)[0]?.areaId).toBe('yard');
    expect(holes(thirdWeek)[0]?.areaId).toBe('yard');
    expect(secondWeek.assignments.filter((item) => item.areaId === 'yard')).toHaveLength(2);
  });

  it('выбывший участник: его зона пустует, остальные шестеро не двигаются', () => {
    const plan = sundayPlan(SUNDAY, { absentUserIds: ['user-L'] });

    expect(assigned(plan)).toEqual([
      'yard:user-I',
      'yard:user-J',
      'fridge:user-K',
      'kitchen:нет (absent)',
      'bathroom:user-M',
      'corridor:user-N',
      'hall:user-O',
    ]);
  });

  it('на следующей неделе выбывший снова в сетке без долга', () => {
    const plan = sundayPlan(parseBusinessDate('2026-09-20'));

    expect(plan.assignments.find((item) => item.userId === 'user-L')?.areaId).toBe('bathroom');
  });

  it('пустое место: зона без исполнителя с причиной «место пустует»', () => {
    const plan = sundayPlan(SUNDAY, { occupants: { ...occupantsOf(SUNDAY_BEDS), L: null } });
    const empty = holes(plan);

    expect(empty).toHaveLength(1);
    expect(empty[0]?.areaId).toBe('kitchen');
    expect(empty[0]?.emptyReason).toBe('empty_bed');
    expect(empty[0]?.bedId).toBe('L');
  });

  it('недопуск: назначение пустое и помнит, кто стоял в очереди', () => {
    const empty = holes(sundayPlan(SUNDAY, { eligibleByArea: YARD_WITHOUT_J }));

    expect(empty).toHaveLength(1);
    expect(empty[0]?.areaId).toBe('yard');
    expect(empty[0]?.emptyReason).toBe('not_eligible');
    expect(empty[0]?.queuedUserId).toBe('user-J');
    expect(empty[0]?.position).toBe(1);
  });

  it('недопущенный не получает другую зону и не идёт в отдых', () => {
    const plan = sundayPlan(SUNDAY, { eligibleByArea: YARD_WITHOUT_J });

    expect(plan.assignments.filter((item) => item.userId === 'user-J')).toHaveLength(0);
    expect(plan.resting).toEqual([]);
  });

  it('зона без записи в группах допуска пускает всех', () => {
    const plan = sundayPlan(SUNDAY, { eligibleByArea: {} });

    expect(holes(plan)).toEqual([]);
  });
});

/**
 * Варианты решения дырки (§2.8): система предлагает, админ решает.
 * Ничего не сохраняется и сетку не меняет — это чтение.
 */

/** Все жильцы дома в порядке показа: три ряда плюс жилец без ряда. */
const HOUSE_RESIDENTS = [
  ...WEDNESDAY_BEDS.map((bed) => `user-${bed}`),
  ...SUNDAY_BEDS.map((bed) => `user-${bed}`),
  'user-X',
];

describe('кандидаты на дырку', () => {
  const plan = sundayPlan(SUNDAY, { absentUserIds: ['user-L'] });

  function candidatesFor(areaId: string, extra: Partial<CandidatesInput> = {}) {
    return resolutionCandidates({
      areaId,
      plan,
      residentUserIds: HOUSE_RESIDENTS,
      absentUserIds: ['user-L'],
      ...extra,
    });
  }

  it('сначала с долгом, потом отдыхающие, потом остальные жильцы дома', () => {
    const restingPlan = wednesdayPlan(WEDNESDAY, {
      rosters: [roster(WEDNESDAY, [...WEDNESDAY_BEDS, 'P', 'Q'])],
      occupants: occupantsOf([...WEDNESDAY_BEDS, 'P', 'Q']),
      absentUserIds: ['user-A'],
    });

    const candidates = resolutionCandidates({
      areaId: 'kitchen',
      plan: restingPlan,
      residentUserIds: [...HOUSE_RESIDENTS, 'user-P', 'user-Q'],
      absentUserIds: ['user-A'],
      debtBalances: { 'user-Q': 1 },
    });

    expect(candidates.slice(0, 2)).toEqual([
      { userId: 'user-Q', source: 'debt', eligible: true, busyAreaIds: [] },
      { userId: 'user-P', source: 'resting', eligible: true, busyAreaIds: [] },
    ]);
    expect(candidates.every((item) => item.userId !== 'user-A')).toBe(true);
  });

  it('долг нулевой или в минусе не делает кандидата должником', () => {
    const candidates = candidatesFor('kitchen', {
      debtBalances: { 'user-M': 0, 'user-N': -1, 'user-A': 2 },
    });

    expect(candidates[0]).toEqual({
      userId: 'user-A',
      source: 'debt',
      eligible: true,
      busyAreaIds: [],
    });
    expect(candidates.find((item) => item.userId === 'user-N')?.source).toBe('resident');
  });

  it('занятый в этот день предлагается, но помечен своей зоной', () => {
    expect(candidatesFor('kitchen').find((item) => item.userId === 'user-N')).toEqual({
      userId: 'user-N',
      source: 'resident',
      eligible: true,
      busyAreaIds: ['corridor'],
    });
  });

  it('недопущенный остаётся в списке с пометкой, а не исчезает', () => {
    const candidates = candidatesFor('yard', { eligibleByArea: YARD_WITHOUT_J });

    expect(candidates.find((item) => item.userId === 'user-J')?.eligible).toBe(false);
    expect(candidates.find((item) => item.userId === 'user-K')?.eligible).toBe(true);
  });

  it('каждый предлагается один раз, даже если подходит сразу двум группам', () => {
    const userIds = candidatesFor('kitchen', { debtBalances: { 'user-N': 3 } }).map(
      (item) => item.userId,
    );

    expect(new Set(userIds).size).toBe(userIds.length);
  });
});

describe('обмены в один ход', () => {
  const plan = sundayPlan(SUNDAY, { absentUserIds: ['user-L'] });

  function swapsFor(areaId: string, extra: Partial<CandidatesInput> = {}) {
    return swapOptions({
      areaId,
      plan,
      residentUserIds: HOUSE_RESIDENTS,
      absentUserIds: ['user-L'],
      debtBalances: { 'user-A': 1 },
      ...extra,
    });
  }

  it('пример владельца: N с коридора на кухню, на коридор — кандидат с долгом', () => {
    const option = swapsFor('kitchen').find((item) => item.userId === 'user-N');

    expect(option?.fromAreaId).toBe('corridor');
    expect(option?.toAreaId).toBe('kitchen');
    expect(option?.replacements[0]?.userId).toBe('user-A');
  });

  it('предлагаются все занятые в этот день, по порядку их зон', () => {
    expect(swapsFor('kitchen').map((item) => `${item.userId}:${item.fromAreaId}`)).toEqual([
      'user-I:yard',
      'user-J:yard',
      'user-K:fridge',
      'user-M:bathroom',
      'user-N:corridor',
      'user-O:hall',
    ]);
  });

  it('не допущенный к зоне дырки в обмен не предлагается', () => {
    const swaps = swapsFor('yard', { eligibleByArea: YARD_WITHOUT_J });

    expect(swaps.every((item) => item.userId !== 'user-J')).toBe(true);
    expect(swaps.some((item) => item.userId === 'user-K')).toBe(true);
  });

  it('на освободившуюся зону предлагаются только допущенные', () => {
    const swaps = swapsFor('kitchen', { eligibleByArea: { corridor: ['user-A', 'user-N'] } });
    const option = swaps.find((item) => item.fromAreaId === 'corridor');

    expect(option?.replacements.map((item) => item.userId)).toEqual(['user-A']);
  });

  it('обмен зоны на саму себя не предлагается: двор на двоих, один выбыл', () => {
    const yardPlan = sundayPlan(SUNDAY, { absentUserIds: ['user-J'] });
    const swaps = swapOptions({
      areaId: 'yard',
      plan: yardPlan,
      residentUserIds: HOUSE_RESIDENTS,
      absentUserIds: ['user-J'],
    });

    expect(swaps.every((item) => item.fromAreaId !== 'yard')).toBe(true);
  });
});
