import { describe, expect, it } from 'vitest';

import { addDays, parseBusinessDate } from '@/lib/time';

import {
  assignmentAt,
  rotationVector,
  weekAssignments,
  weekIndex,
  type RotationDuty,
  type RotationRowZone,
} from './rotation-grid';

/**
 * Сетка ротаций: числовой пример 6.1 из docs/03-BUSINESS-RULES.md §6.2.
 * Ядро чистое: ни БД, ни часов, ни истории исполнения.
 */

/** Дата первой ротации ряда из примера 6.1. Понедельник. */
const START = parseBusinessDate('2026-09-07');

function zone(areaId: string, peopleNeeded = 1): RotationRowZone {
  return { areaId, checklistId: `checklist-${areaId}`, peopleNeeded };
}

/** Пять зон примера 6.1 в порядке ряда. */
const EXAMPLE_ZONES: RotationRowZone[] = [
  zone('hall'),
  zone('kitchen'),
  zone('stairs'),
  zone('toilet-1'),
  zone('toilet-2'),
];

/** Шесть мест примера 6.1: сама сетка знает только их число. */
const EXAMPLE_SLOTS = 6;

/** Короткая запись обязанности для сравнения матриц: зона или «отдых». */
function label(duty: RotationDuty): string {
  return duty.kind === 'rest' ? 'отдых' : duty.areaId;
}

describe('вектор обязанностей', () => {
  it('пример 6.1: пять зон и одно место отдыха на шесть слотов', () => {
    expect(rotationVector(EXAMPLE_ZONES, EXAMPLE_SLOTS).map(label)).toEqual([
      'hall',
      'kitchen',
      'stairs',
      'toilet-1',
      'toilet-2',
      'отдых',
    ]);
  });

  it('зона с people_needed = 2 занимает два слота подряд', () => {
    expect(rotationVector([zone('yard', 2), zone('hall')], 4).map(label)).toEqual([
      'yard',
      'yard',
      'hall',
      'отдых',
    ]);
  });

  it('вектор несёт идентификатор чек-листа, а не только зоны', () => {
    expect(rotationVector([zone('yard', 2)], 2)).toEqual([
      { kind: 'zone', areaId: 'yard', checklistId: 'checklist-yard' },
      { kind: 'zone', areaId: 'yard', checklistId: 'checklist-yard' },
    ]);
  });

  it('без отдыха: обязанностей ровно столько же, сколько слотов', () => {
    expect(rotationVector(EXAMPLE_ZONES, 5).map(label)).toEqual([
      'hall',
      'kitchen',
      'stairs',
      'toilet-1',
      'toilet-2',
    ]);
  });

  it('D больше S: шесть обязанностей на пять слотов — ошибка, а не молчаливое усечение', () => {
    expect(() => rotationVector([...EXAMPLE_ZONES, zone('yard')], 5)).toThrow(
      /обязанностей \(6\).*слотов \(5\)/,
    );
  });

  it('D больше S за счёт people_needed одной зоны — та же ошибка', () => {
    expect(() => rotationVector([zone('yard', 3)], 2)).toThrow(/обязанностей \(3\).*слотов \(2\)/);
  });

  it('ряд без слотов не даёт сетки', () => {
    expect(() => rotationVector([], 0)).toThrow(/хотя бы одно место/);
  });

  it('people_needed меньше единицы — ошибка', () => {
    expect(() => rotationVector([zone('yard', 0)], 2)).toThrow(/people_needed/);
  });

  it('дробный people_needed — ошибка', () => {
    expect(() => rotationVector([zone('yard', 1.5)], 2)).toThrow(/people_needed/);
  });
});

describe('номер недели', () => {
  it('в дату первой ротации ряда неделя нулевая', () => {
    expect(weekIndex(START, START)).toBe(0);
  });

  it('через семь дней — неделя первая', () => {
    expect(weekIndex(START, addDays(START, 7))).toBe(1);
  });

  it('через двадцать восемь дней — неделя четвёртая', () => {
    expect(weekIndex(START, addDays(START, 28))).toBe(4);
  });

  it('перенос внутри недели номера не меняет: девятый день — всё ещё неделя первая', () => {
    expect(weekIndex(START, addDays(START, 9))).toBe(1);
  });

  it('отменённая неделя не сдвигает следующие: через четырнадцать дней неделя вторая', () => {
    // Сетка считается от календаря, а не от числа проведённых ротаций (§6.2).
    // Отмена ротации на седьмой день ничего здесь не меняет: аргумент — дата.
    expect(weekIndex(START, addDays(START, 14))).toBe(2);
  });

  it('дата раньше первой ротации ряда — ошибка', () => {
    expect(() => weekIndex(START, addDays(START, -1))).toThrow(/раньше первой ротации/);
  });
});

describe('назначение слота', () => {
  const vector = rotationVector(EXAMPLE_ZONES, EXAMPLE_SLOTS);

  it('пример 6.1, неделя 0', () => {
    expect(weekAssignments(vector, 0).map(label)).toEqual([
      'hall',
      'kitchen',
      'stairs',
      'toilet-1',
      'toilet-2',
      'отдых',
    ]);
  });

  it('пример 6.1, неделя 1', () => {
    expect(weekAssignments(vector, 1).map(label)).toEqual([
      'kitchen',
      'stairs',
      'toilet-1',
      'toilet-2',
      'отдых',
      'hall',
    ]);
  });

  it('слот 5 на неделе 1 получает зал, а слот 4 отдыхает', () => {
    expect(label(assignmentAt(vector, 5, 1))).toBe('hall');
    expect(label(assignmentAt(vector, 4, 1))).toBe('отдых');
  });

  it('через полный цикл из S недель сетка повторяется', () => {
    expect(weekAssignments(vector, EXAMPLE_SLOTS).map(label)).toEqual(
      weekAssignments(vector, 0).map(label),
    );
  });

  it('слот вне ряда — ошибка', () => {
    expect(() => assignmentAt(vector, EXAMPLE_SLOTS, 0)).toThrow(/слот/);
    expect(() => assignmentAt(vector, -1, 0)).toThrow(/слот/);
  });

  it('отрицательная неделя — ошибка', () => {
    expect(() => assignmentAt(vector, 0, -1)).toThrow(/недел/);
  });
});

describe('четыре недели подряд', () => {
  const vector = rotationVector(EXAMPLE_ZONES, EXAMPLE_SLOTS);
  const weeks = [0, 1, 2, 3].map((k) => weekAssignments(vector, k).map(label));

  it('матрица четырёх недель воспроизводится по формуле', () => {
    expect(weeks).toEqual([
      ['hall', 'kitchen', 'stairs', 'toilet-1', 'toilet-2', 'отдых'],
      ['kitchen', 'stairs', 'toilet-1', 'toilet-2', 'отдых', 'hall'],
      ['stairs', 'toilet-1', 'toilet-2', 'отдых', 'hall', 'kitchen'],
      ['toilet-1', 'toilet-2', 'отдых', 'hall', 'kitchen', 'stairs'],
    ]);
  });

  it('каждая зона убирается ровно один раз в неделю', () => {
    for (const week of weeks) {
      const zones = week.filter((duty) => duty !== 'отдых');
      expect(zones).toHaveLength(EXAMPLE_ZONES.length);
      expect(new Set(zones).size).toBe(EXAMPLE_ZONES.length);
    }
  });

  it('никто не убирает две зоны в одну неделю', () => {
    for (const week of weeks) {
      expect(week).toHaveLength(EXAMPLE_SLOTS);
    }
  });
});

describe('полный цикл', () => {
  it('за S недель каждый слот отдыхает ровно S - D недель', () => {
    const vector = rotationVector(EXAMPLE_ZONES, EXAMPLE_SLOTS);
    const restWeeks = Array.from({ length: EXAMPLE_SLOTS }, () => 0);

    for (let k = 0; k < EXAMPLE_SLOTS; k += 1) {
      weekAssignments(vector, k).forEach((duty, slot) => {
        if (duty.kind === 'rest') {
          restWeeks[slot] = (restWeeks[slot] ?? 0) + 1;
        }
      });
    }

    expect(restWeeks).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('зона с people_needed = 2 даёт каждому слоту по два отдыха из четырёх недель', () => {
    const vector = rotationVector([zone('yard', 2)], 4);
    const restWeeks = Array.from({ length: 4 }, () => 0);

    for (let k = 0; k < 4; k += 1) {
      weekAssignments(vector, k).forEach((duty, slot) => {
        if (duty.kind === 'rest') {
          restWeeks[slot] = (restWeeks[slot] ?? 0) + 1;
        }
      });
    }

    expect(restWeeks).toEqual([2, 2, 2, 2]);
  });

  it('за S недель каждый слот убирает каждую зону ровно people_needed раз', () => {
    const zones = [zone('yard', 2), zone('hall'), zone('kitchen')];
    const slots = 5;
    const vector = rotationVector(zones, slots);

    for (let slot = 0; slot < slots; slot += 1) {
      const duties = Array.from({ length: slots }, (_, k) => label(assignmentAt(vector, slot, k)));

      expect(duties.filter((duty) => duty === 'yard')).toHaveLength(2);
      expect(duties.filter((duty) => duty === 'hall')).toHaveLength(1);
      expect(duties.filter((duty) => duty === 'kitchen')).toHaveLength(1);
      expect(duties.filter((duty) => duty === 'отдых')).toHaveLength(1);
    }
  });
});
