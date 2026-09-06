import { describe, expect, it } from 'vitest';

import { businessDate, parseBusinessDate } from '@/lib/time';

import { parsePeriod, periodLiteral } from './period';

describe('период занятости места', () => {
  it('записывается полуоткрытым интервалом', () => {
    expect(periodLiteral({ from: businessDate(2026, 9, 1), to: businessDate(2026, 12, 1) })).toBe(
      '[2026-09-01,2026-12-01)',
    );
  });

  it('открытый договор записывается без верхней границы', () => {
    expect(periodLiteral({ from: businessDate(2026, 9, 1), to: null })).toBe('[2026-09-01,)');
  });

  it('пустой период отвергается: конец обязан быть позже начала', () => {
    const from = businessDate(2026, 9, 1);

    expect(() => periodLiteral({ from, to: from })).toThrow(/период/i);
    expect(() => periodLiteral({ from, to: businessDate(2026, 8, 31) })).toThrow(/период/i);
  });

  it('разбирается обратно', () => {
    expect(parsePeriod('[2026-09-01,2026-12-01)')).toEqual({
      from: parseBusinessDate('2026-09-01'),
      to: parseBusinessDate('2026-12-01'),
    });
    expect(parsePeriod('[2026-09-01,)')).toEqual({
      from: parseBusinessDate('2026-09-01'),
      to: null,
    });
  });

  it('мусор отвергается, а не разбирается наполовину', () => {
    for (const literal of [
      '',
      '2026-09-01',
      '(2026-09-01,2026-12-01)',
      '[2026-09-01,2026-12-01]',
    ]) {
      expect(() => parsePeriod(literal), literal).toThrow(/период/i);
    }
  });

  /**
   * День выезда в период не входит: иначе новый жилец не смог бы заехать
   * в день, когда место освободилось, — а это обычный случай.
   */
  it('смежные периоды не пересекаются', () => {
    const first = periodLiteral({ from: businessDate(2026, 9, 1), to: businessDate(2026, 12, 1) });
    const second = periodLiteral({ from: businessDate(2026, 12, 1), to: null });

    expect(first).toBe('[2026-09-01,2026-12-01)');
    expect(second).toBe('[2026-12-01,)');
  });
});
