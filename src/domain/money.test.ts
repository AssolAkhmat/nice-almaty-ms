import { describe, expect, it } from 'vitest';

import { splitCeil } from './money';

/**
 * Числовые примеры взяты из docs/03-BUSINESS-RULES.md.
 * Правило §0: доля каждого участника округляется вверх до целого тенге,
 * сумма долей может превысить исходную, излишек остаётся дому.
 */
describe('splitCeil', () => {
  it('пример §0.1: 1800 на 17 человек — по 106, сумма 1802, излишек 2', () => {
    const result = splitCeil(1800, new Array<number>(17).fill(1));

    expect(result.shares).toHaveLength(17);
    expect(result.shares.every((share) => share === 106)).toBe(true);
    expect(result.shares.reduce((sum, share) => sum + share, 0)).toBe(1802);
    expect(result.surplus).toBe(2);
  });

  it('пример §8.1: ручка 1800 на 18 участников — по 100, излишка нет', () => {
    const result = splitCeil(1800, new Array<number>(18).fill(1));

    expect(result.shares.every((share) => share === 100)).toBe(true);
    expect(result.surplus).toBe(0);
  });

  it('пример §4.1: коммуналка 30000 на дни 10/20/30 — 5000/10000/15000, излишка нет', () => {
    const result = splitCeil(30_000, [10, 20, 30]);

    expect(result.shares).toEqual([5000, 10_000, 15_000]);
    expect(result.surplus).toBe(0);
  });

  it('пример §4.2: коммуналка 30000 на дни 11/20/30 — 5410/9837/14755, излишек 2', () => {
    const result = splitCeil(30_000, [11, 20, 30]);

    expect(result.shares).toEqual([5410, 9837, 14_755]);
    expect(result.surplus).toBe(2);
  });

  it('инвариант §0: излишек равен превышению суммы долей над исходной суммой', () => {
    const cases: ReadonlyArray<readonly [number, readonly number[]]> = [
      [1800, new Array<number>(17).fill(1)],
      [30_000, [11, 20, 30]],
      [45_000, [1, 2, 3, 4, 5, 6, 7]],
      [7, [1, 1, 1]],
      [1, [1, 1]],
    ];

    for (const [total, weights] of cases) {
      const result = splitCeil(total, weights);
      const sum = result.shares.reduce((acc, share) => acc + share, 0);

      expect(sum - total).toBe(result.surplus);
      expect(result.surplus).toBeGreaterThanOrEqual(0);
    }
  });

  it('каждая доля — целое число тенге, не меньше нуля', () => {
    const result = splitCeil(1, [1, 1, 1]);

    expect(result.shares).toEqual([1, 1, 1]);
    expect(result.surplus).toBe(2);
  });

  it('нулевая сумма делится в нули без излишка', () => {
    const result = splitCeil(0, [1, 2, 3]);

    expect(result.shares).toEqual([0, 0, 0]);
    expect(result.surplus).toBe(0);
  });

  it('участник с нулевым весом не платит', () => {
    const result = splitCeil(1000, [0, 1, 1]);

    expect(result.shares[0]).toBe(0);
    expect(result.shares[1]).toBe(500);
    expect(result.shares[2]).toBe(500);
    expect(result.surplus).toBe(0);
  });

  it('порядок долей соответствует порядку весов', () => {
    const result = splitCeil(30_000, [30, 20, 11]);

    expect(result.shares).toEqual([14_755, 9837, 5410]);
  });

  describe('отказывается делить вместо тихой потери денег', () => {
    it('без участников', () => {
      expect(() => splitCeil(1000, [])).toThrow(/участник/i);
    });

    it('все веса нулевые', () => {
      expect(() => splitCeil(1000, [0, 0])).toThrow(/вес/i);
    });

    it('отрицательная сумма', () => {
      expect(() => splitCeil(-1, [1])).toThrow(/сумма/i);
    });

    it('дробная сумма — тиынов нет', () => {
      expect(() => splitCeil(10.5, [1])).toThrow(/сумма/i);
    });

    it('отрицательный вес', () => {
      expect(() => splitCeil(1000, [1, -1])).toThrow(/вес/i);
    });

    it('дробный вес', () => {
      expect(() => splitCeil(1000, [1, 1.5])).toThrow(/вес/i);
    });
  });
});
