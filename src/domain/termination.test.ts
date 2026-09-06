import { describe, expect, it } from 'vitest';

import { parseBusinessDate } from '@/lib/time';

import {
  daysUntilRefundDeadline,
  moveOutDateProblem,
  refundDeadline,
  REFUND_DEADLINE_DAYS,
} from './termination';

/**
 * Расторжение договора (docs/03-BUSINESS-RULES.md §2.3).
 * Числа взяты из правила, а не из реализации: 30 дней от даты расторжения.
 */
describe('крайний срок возврата депозита', () => {
  it('тридцать дней от даты расторжения', () => {
    expect(REFUND_DEADLINE_DAYS).toBe(30);
    expect(refundDeadline(parseBusinessDate('2026-09-15'))).toBe('2026-10-15');
  });

  it('считается по календарю, а не по длине месяца', () => {
    // Февраль короче: тридцатый день от 1 февраля 2027 — 3 марта.
    expect(refundDeadline(parseBusinessDate('2027-02-01'))).toBe('2027-03-03');
  });

  it('переходит через год', () => {
    expect(refundDeadline(parseBusinessDate('2026-12-20'))).toBe('2027-01-19');
  });
});

describe('счётчик дней до возврата', () => {
  it('в день расторжения остаётся тридцать дней', () => {
    expect(
      daysUntilRefundDeadline(parseBusinessDate('2026-09-15'), parseBusinessDate('2026-09-15')),
    ).toBe(30);
  });

  it('в крайний день остаётся ноль, а не единица', () => {
    expect(
      daysUntilRefundDeadline(parseBusinessDate('2026-09-15'), parseBusinessDate('2026-10-15')),
    ).toBe(0);
  });

  it('после крайнего дня счётчик отрицательный: это просрочка, а не ноль', () => {
    expect(
      daysUntilRefundDeadline(parseBusinessDate('2026-09-15'), parseBusinessDate('2026-10-18')),
    ).toBe(-3);
  });
});

describe('дата выезда', () => {
  const today = parseBusinessDate('2026-09-15');
  const moveIn = parseBusinessDate('2026-03-01');

  it('сегодня — значение по умолчанию и потому допустимо', () => {
    expect(moveOutDateProblem({ moveIn, moveOut: today, today })).toBeNull();
  });

  it('будущая дата допустима: место освобождается с неё', () => {
    expect(
      moveOutDateProblem({ moveIn, moveOut: parseBusinessDate('2026-10-01'), today }),
    ).toBeNull();
  });

  it('прошедшая дата отклоняется: модалка предлагает сегодня или позже', () => {
    expect(moveOutDateProblem({ moveIn, moveOut: parseBusinessDate('2026-09-14'), today })).toBe(
      'inPast',
    );
  });

  it('дата раньше заезда отклоняется', () => {
    expect(
      moveOutDateProblem({
        moveIn: parseBusinessDate('2026-10-01'),
        moveOut: parseBusinessDate('2026-09-20'),
        today,
      }),
    ).toBe('beforeMoveIn');
  });

  it('проживание без даты заезда сравнивать не с чем — проверяется только прошлое', () => {
    expect(moveOutDateProblem({ moveIn: null, moveOut: today, today })).toBeNull();
  });
});
