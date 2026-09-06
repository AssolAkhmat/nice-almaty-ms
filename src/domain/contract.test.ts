import { describe, expect, it } from 'vitest';

import { businessDate, parseBusinessDate } from '@/lib/time';

import { contractEndDate } from './contract';

/**
 * Таблица из docs/03-BUSINESS-RULES.md §1.1. Каждая строка — отдельная проверка:
 * правило простое, но именно на нём стоит срок договора и весь расчёт депозита.
 */
describe('дата окончания договора', () => {
  const cases: [string, string][] = [
    ['2026-09-01', '2027-07-01'],
    ['2027-02-10', '2027-07-01'],
    ['2027-06-15', '2027-07-01'],
    ['2027-08-20', '2028-07-01'],
  ];

  for (const [start, expected] of cases) {
    it(`${start} → ${expected}`, () => {
      expect(contractEndDate(parseBusinessDate(start))).toBe(expected);
    });
  }

  it('январь и июнь дают первое июля того же года', () => {
    expect(contractEndDate(businessDate(2027, 1, 1))).toBe('2027-07-01');
    expect(contractEndDate(businessDate(2027, 6, 30))).toBe('2027-07-01');
  });

  it('июль и декабрь дают первое июля следующего года', () => {
    expect(contractEndDate(businessDate(2027, 7, 1))).toBe('2028-07-01');
    expect(contractEndDate(businessDate(2027, 12, 31))).toBe('2028-07-01');
  });

  /**
   * Граница проходит между июнем и июлем: заезд 30 июня заканчивается
   * через день, заезд 1 июля — через год. Это не ошибка, а правило владельца:
   * учебный год считается от первого июля.
   */
  it('граница между июнем и июлем — самое опасное место правила', () => {
    expect(contractEndDate(businessDate(2027, 6, 30))).toBe('2027-07-01');
    expect(contractEndDate(businessDate(2027, 7, 1))).toBe('2028-07-01');
  });

  it('високосный год не меняет правило', () => {
    expect(contractEndDate(businessDate(2028, 2, 29))).toBe('2028-07-01');
  });
});
