import { describe, expect, it } from 'vitest';

import { parseBusinessDate } from '@/lib/time';

import { countFullMonths, decideDepositOutcome, MIN_FULL_MONTHS_FOR_REFUND } from './deposit';

/**
 * Числовые примеры из docs/03-BUSINESS-RULES.md §2.1 и §2.2.
 * Месяц полный, если проживание покрывает все его календарные дни.
 */
describe('полные месяцы проживания', () => {
  it('пример 2.1: заезд 27.08.2026, выезд 15.11.2026 — два полных месяца', () => {
    expect(countFullMonths(parseBusinessDate('2026-08-27'), parseBusinessDate('2026-11-15'))).toBe(
      2,
    );
  });

  it('пример 2.2: заезд 27.08.2026, выезд 01.12.2026 — три полных месяца', () => {
    expect(countFullMonths(parseBusinessDate('2026-08-27'), parseBusinessDate('2026-12-01'))).toBe(
      3,
    );
  });

  it('пример 2.3: заезд 01.09.2026, выезд 30.11.2026 — три полных месяца', () => {
    expect(countFullMonths(parseBusinessDate('2026-09-01'), parseBusinessDate('2026-11-30'))).toBe(
      3,
    );
  });

  it('месяц заезда не полный, если заехали не первого', () => {
    expect(countFullMonths(parseBusinessDate('2026-09-02'), parseBusinessDate('2026-09-30'))).toBe(
      0,
    );
  });

  it('месяц выезда не полный, если выехали не последним днём', () => {
    expect(countFullMonths(parseBusinessDate('2026-09-01'), parseBusinessDate('2026-09-29'))).toBe(
      0,
    );
  });

  it('ровно один календарный месяц целиком считается полным', () => {
    expect(countFullMonths(parseBusinessDate('2026-09-01'), parseBusinessDate('2026-09-30'))).toBe(
      1,
    );
  });

  it('февраль считается по своей длине', () => {
    expect(countFullMonths(parseBusinessDate('2027-02-01'), parseBusinessDate('2027-02-28'))).toBe(
      1,
    );
    expect(countFullMonths(parseBusinessDate('2028-02-01'), parseBusinessDate('2028-02-28'))).toBe(
      0,
    );
    expect(countFullMonths(parseBusinessDate('2028-02-01'), parseBusinessDate('2028-02-29'))).toBe(
      1,
    );
  });

  it('выезд раньше заезда полных месяцев не даёт', () => {
    expect(countFullMonths(parseBusinessDate('2026-11-01'), parseBusinessDate('2026-09-01'))).toBe(
      0,
    );
  });

  it('переход через год считается', () => {
    expect(countFullMonths(parseBusinessDate('2026-12-01'), parseBusinessDate('2027-01-31'))).toBe(
      2,
    );
  });
});

/**
 * §2.2: меньше трёх полных месяцев — депозит сгорает,
 * три и больше — возвращается.
 */
describe('судьба депозита при выселении', () => {
  it('порог — три полных месяца', () => {
    expect(MIN_FULL_MONTHS_FOR_REFUND).toBe(3);
  });

  it('меньше трёх месяцев — сгорание на весь остаток', () => {
    const outcome = decideDepositOutcome({ fullMonths: 2, balance: 45_000 });

    expect(outcome.kind).toBe('burn');
    expect(outcome.amount).toBe(45_000);
  });

  it('три месяца — возврат остатка', () => {
    const outcome = decideDepositOutcome({ fullMonths: 3, balance: 45_000 });

    expect(outcome.kind).toBe('refund');
    expect(outcome.amount).toBe(45_000);
  });

  it('остаток после ущерба возвращается в уменьшенном размере', () => {
    expect(decideDepositOutcome({ fullMonths: 5, balance: 31_200 })).toEqual({
      kind: 'refund',
      amount: 31_200,
      debt: 0,
    });
  });

  it('нулевой остаток не создаёт возврата на ноль тенге', () => {
    expect(decideDepositOutcome({ fullMonths: 5, balance: 0 })).toEqual({
      kind: 'nothing',
      amount: 0,
      debt: 0,
    });
    expect(decideDepositOutcome({ fullMonths: 1, balance: 0 })).toEqual({
      kind: 'nothing',
      amount: 0,
      debt: 0,
    });
  });

  /**
   * §2.4: ущерб может увести депозит в минус. Возвращать нечего,
   * и долг обязан остаться видимым, а не потеряться при округлении к нулю.
   */
  it('отрицательный остаток — это долг, а не возврат', () => {
    expect(decideDepositOutcome({ fullMonths: 5, balance: -3_500 })).toEqual({
      kind: 'debt',
      amount: 0,
      debt: 3_500,
    });
  });

  it('отрицательный остаток при коротком проживании тоже долг, а не сгорание', () => {
    // Сгорать нечему: депозит уже израсходован ущербом.
    expect(decideDepositOutcome({ fullMonths: 1, balance: -1 })).toEqual({
      kind: 'debt',
      amount: 0,
      debt: 1,
    });
  });

  it('дробные тенге не принимаются: деньги целые', () => {
    expect(() => decideDepositOutcome({ fullMonths: 3, balance: 10.5 })).toThrow(/тенге/i);
  });

  it('отрицательное число месяцев не принимается', () => {
    expect(() => decideDepositOutcome({ fullMonths: -1, balance: 1000 })).toThrow(/месяц/i);
  });
});
