import { describe, expect, it } from 'vitest';

import { parseBusinessDate } from '@/lib/time';

import {
  summarizeByArea,
  summarizeByPerson,
  summarizeByWeekday,
  summarizeMonths,
  type StatsRecord,
} from './rotation-stats';

/**
 * Статистика ротаций (docs/04-MODULES/04-rotation-scoring.md).
 * Чистые функции: считают по готовым записям, ничего не спрашивая у базы.
 */
function record(overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    userId: 'azamat',
    areaId: 'yard',
    date: parseBusinessDate('2026-09-07'),
    state: 'confirmed',
    score: 8,
    ...overrides,
  };
}

describe('свод по жильцу', () => {
  it('считает выполненные, пропущенные и среднюю оценку', () => {
    const [azamat] = summarizeByPerson([
      record({ score: 8 }),
      record({ score: 6 }),
      record({ state: 'missed', score: 1 }),
    ]);

    expect(azamat?.done).toBe(2);
    expect(azamat?.missed).toBe(1);
    // (8 + 6 + 1) / 3 = 5
    expect(azamat?.averageScore).toBe(5);
  });

  it('неоценённые в среднее не входят, но в счёт выполненных — да', () => {
    const [azamat] = summarizeByPerson([record({ score: 10 }), record({ score: null })]);

    expect(azamat?.done).toBe(2);
    expect(azamat?.averageScore).toBe(10);
  });

  it('без единой оценки среднего нет, а не ноль', () => {
    const [azamat] = summarizeByPerson([record({ score: null })]);

    expect(azamat?.averageScore).toBeNull();
  });

  it('люди идут от худшего среднего к лучшему: список читают сверху', () => {
    const summary = summarizeByPerson([
      record({ userId: 'azamat', score: 9 }),
      record({ userId: 'daniyar', score: 3 }),
      record({ userId: 'arman', score: 6 }),
    ]);

    expect(summary.map((item) => item.userId)).toEqual(['daniyar', 'arman', 'azamat']);
  });

  it('отменённые ротации в статистику не идут вовсе', () => {
    const summary = summarizeByPerson([record({ state: 'cancelled', score: null })]);

    expect(summary).toEqual([]);
  });

  it('без исполнителя запись в свод по людям не попадает', () => {
    const summary = summarizeByPerson([record({ userId: null })]);

    expect(summary).toEqual([]);
  });
});

describe('динамика по месяцам', () => {
  it('месяцы идут по возрастанию, с числом выполненного и средним', () => {
    const months = summarizeMonths([
      record({ date: parseBusinessDate('2026-10-05'), score: 4 }),
      record({ date: parseBusinessDate('2026-09-07'), score: 8 }),
      record({ date: parseBusinessDate('2026-09-14'), score: 6 }),
    ]);

    expect(months.map((item) => item.month)).toEqual(['2026-09-01', '2026-10-01']);
    expect(months[0]?.averageScore).toBe(7);
    expect(months[0]?.done).toBe(2);
  });
});

describe('свод по зонам', () => {
  it('средняя оценка и частота пропусков по каждой зоне', () => {
    const areas = summarizeByArea([
      record({ areaId: 'yard', score: 4 }),
      record({ areaId: 'yard', state: 'missed', score: 1 }),
      record({ areaId: 'kitchen', score: 9 }),
    ]);

    const yard = areas.find((item) => item.areaId === 'yard');

    expect(yard?.averageScore).toBe(2.5);
    // Пропущена одна из двух — половина.
    expect(yard?.missRate).toBe(0.5);
  });

  it('зоны идут от худшей к лучшей', () => {
    const areas = summarizeByArea([
      record({ areaId: 'yard', score: 9 }),
      record({ areaId: 'kitchen', score: 2 }),
    ]);

    expect(areas.map((item) => item.areaId)).toEqual(['kitchen', 'yard']);
  });
});

describe('свод по дням недели', () => {
  it('день недели считается по календарю Алматы', () => {
    // 7 сентября 2026 — понедельник, 13 сентября — воскресенье.
    const days = summarizeByWeekday([
      record({ date: parseBusinessDate('2026-09-07'), score: 3 }),
      record({ date: parseBusinessDate('2026-09-13'), score: 9 }),
    ]);

    expect(days.map((item) => item.weekday)).toEqual([1, 0]);
    expect(days[0]?.averageScore).toBe(3);
  });

  it('дни идут от худшего к лучшему: у них та же задача, что и у зон', () => {
    const days = summarizeByWeekday([
      record({ date: parseBusinessDate('2026-09-07'), score: 9 }),
      record({ date: parseBusinessDate('2026-09-08'), score: 2 }),
    ]);

    expect(days.map((item) => item.weekday)).toEqual([2, 1]);
  });
});
