import { describe, expect, it } from 'vitest';

import { ACQUIRING_RATE_BP, TAX_RATE_BP, taxReport } from './tax';

/**
 * Калькулятор налогов (docs/03-BUSINESS-RULES.md §10.2).
 *
 * Ставки заданы владельцем и настраиваются; расчёт справочный. Проверяется
 * не «правильность налога» — это не наше дело, — а то, что арифметика идёт
 * в целых тенге и что округление не занижает сумму к вычету.
 */
describe('ставки по умолчанию', () => {
  it('налог 3 %, эквайринг 0,95 % — в базисных пунктах, без дробей', () => {
    expect(TAX_RATE_BP).toBe(300);
    expect(ACQUIRING_RATE_BP).toBe(95);
  });
});

describe('расчёт за период', () => {
  it('налог берётся с дохода, эквайринг — с оборота', () => {
    const report = taxReport({
      kaspiIncome: 1_000_000,
      kaspiTurnover: 1_200_000,
      taxRateBp: TAX_RATE_BP,
      acquiringRateBp: ACQUIRING_RATE_BP,
    });

    expect(report.tax).toBe(30_000);
    expect(report.acquiring).toBe(11_400);
    expect(report.deduction).toBe(41_400);
    expect(report.net).toBe(1_000_000 - 41_400);
  });

  it('дробный результат округляется вверх: справка не занижает вычет', () => {
    const report = taxReport({
      kaspiIncome: 33_333,
      kaspiTurnover: 33_333,
      taxRateBp: 300,
      acquiringRateBp: 95,
    });

    // 33 333 × 3 % = 999,99 → 1000; 33 333 × 0,95 % = 316,66 → 317.
    expect(report.tax).toBe(1_000);
    expect(report.acquiring).toBe(317);
  });

  it('пустой период даёт нули, а не деление на ноль', () => {
    const report = taxReport({
      kaspiIncome: 0,
      kaspiTurnover: 0,
      taxRateBp: 300,
      acquiringRateBp: 95,
    });

    expect(report).toEqual({ tax: 0, acquiring: 0, deduction: 0, net: 0 });
  });

  it('нулевые ставки не берут ничего: их разрешено выставить', () => {
    const report = taxReport({
      kaspiIncome: 500_000,
      kaspiTurnover: 500_000,
      taxRateBp: 0,
      acquiringRateBp: 0,
    });

    expect(report.deduction).toBe(0);
    expect(report.net).toBe(500_000);
  });

  it('отрицательная ставка и дробная сумма — ошибка ввода, а не «ноль»', () => {
    expect(() =>
      taxReport({ kaspiIncome: 1, kaspiTurnover: 1, taxRateBp: -1, acquiringRateBp: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      taxReport({ kaspiIncome: 1.5, kaspiTurnover: 1, taxRateBp: 300, acquiringRateBp: 95 }),
    ).toThrow(RangeError);
  });
});
