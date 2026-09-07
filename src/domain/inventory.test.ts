import { describe, expect, it } from 'vitest';

import {
  applyMovement,
  auditDifference,
  formatQty,
  InventoryQtyError,
  parseQty,
} from './inventory';

/**
 * Количества инвентаря считаются целыми сотыми долями по той же причине,
 * по какой деньги считаются целыми тенге: `0.1 + 0.2` в double не даёт
 * `0.3`, и на третьем перемещении банки краски это стало бы видно.
 */
describe('разбор количества', () => {
  it('целое и дробное читаются одинаково', () => {
    expect(parseQty('3')).toBe(300);
    expect(parseQty('3.5')).toBe(350);
    expect(parseQty('3.05')).toBe(305);
  });

  it('отрицательное количество допустимо: это корректировка', () => {
    expect(parseQty('-2.50')).toBe(-250);
  });

  it('мусор и лишняя точность отклоняются', () => {
    for (const value of ['', '1.234', 'два', '1,5', '1.']) {
      expect(() => parseQty(value), value).toThrow(InventoryQtyError);
    }
  });

  it('запись и разбор возвращают то же число', () => {
    for (const hundredths of [0, 1, 99, 100, 1234, -450]) {
      expect(parseQty(formatQty(hundredths)), String(hundredths)).toBe(hundredths);
    }
  });

  it('дробная часть всегда из двух знаков', () => {
    expect(formatQty(350)).toBe('3.50');
    expect(formatQty(305)).toBe('3.05');
    expect(formatQty(300)).toBe('3.00');
    expect(formatQty(-250)).toBe('-2.50');
  });
});

describe('движение по позиции', () => {
  it('приход прибавляет, расход и списание вычитают', () => {
    expect(applyMovement(1000, 'in', 250)).toBe(1250);
    expect(applyMovement(1000, 'out', 250)).toBe(750);
    expect(applyMovement(1000, 'write_off', 1000)).toBe(0);
  });

  it('перемещение количества не меняет: меняется дом', () => {
    expect(applyMovement(1000, 'transfer', 1000)).toBe(1000);
  });

  it('корректировка приходит со знаком и прибавляется как есть', () => {
    expect(applyMovement(1000, 'audit_adjust', -300)).toBe(700);
    expect(applyMovement(1000, 'audit_adjust', 300)).toBe(1300);
  });

  it('дроби складываются точно, а не почти', () => {
    const tenth = parseQty('0.10');
    const fifth = parseQty('0.20');

    expect(formatQty(applyMovement(tenth, 'in', fifth))).toBe('0.30');
  });
});

describe('расхождение ведомости', () => {
  it('факт больше учёта — излишек, меньше — недостача', () => {
    expect(auditDifference('10.00', '12.50')).toBe(250);
    expect(auditDifference('10.00', '7.00')).toBe(-300);
    expect(auditDifference('10.00', '10.00')).toBe(0);
  });

  it('непроверенная строка расхождения не даёт', () => {
    expect(auditDifference('10.00', null)).toBeNull();
  });
});
