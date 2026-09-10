import { describe, expect, it } from 'vitest';

import { debtBalance, debtStepOf } from './rotation-debt';

/**
 * Долг по дополнительным ротациям — книга со знаком
 * (docs/03-BUSINESS-RULES.md §7, docs/tasks/PHASE-10.md §2.7).
 *
 * Строка `+1` — ротация не выполнена, строка `−1` — выполнена ротация
 * с галочкой «списать доп. ротацию». Баланс — сумма строк, и он вправе
 * уйти в минус: минус — это запас.
 */
describe('шаг книги долга по назначению', () => {
  it('не выполнена — плюс один', () => {
    expect(
      debtStepOf({ state: 'missed', writeOffDebt: false, hasExecutor: true, cancelled: false }),
    ).toBe(1);
  });

  it('выполнена с галочкой списания — минус один', () => {
    expect(
      debtStepOf({ state: 'confirmed', writeOffDebt: true, hasExecutor: true, cancelled: false }),
    ).toBe(-1);
  });

  it('выполнена без галочки — долг не трогается', () => {
    expect(
      debtStepOf({ state: 'confirmed', writeOffDebt: false, hasExecutor: true, cancelled: false }),
    ).toBe(0);
  });

  it('галочка без подтверждения ничего не списывает (P10-3)', () => {
    expect(
      debtStepOf({ state: 'assigned', writeOffDebt: true, hasExecutor: true, cancelled: false }),
    ).toBe(0);
  });

  it('не выполнена с галочкой — обычный плюс один, как любая ротация', () => {
    expect(
      debtStepOf({ state: 'missed', writeOffDebt: true, hasExecutor: true, cancelled: false }),
    ).toBe(1);
  });

  it('отменённое занятие не влияет на долг (§7)', () => {
    expect(
      debtStepOf({ state: 'missed', writeOffDebt: false, hasExecutor: true, cancelled: true }),
    ).toBe(0);
    expect(
      debtStepOf({ state: 'confirmed', writeOffDebt: true, hasExecutor: true, cancelled: true }),
    ).toBe(0);
  });

  it('отменённое назначение не влияет на долг', () => {
    expect(
      debtStepOf({ state: 'cancelled', writeOffDebt: true, hasExecutor: true, cancelled: false }),
    ).toBe(0);
  });

  it('дырка без исполнителя долга никому не даёт (§6.3)', () => {
    expect(
      debtStepOf({ state: 'missed', writeOffDebt: false, hasExecutor: false, cancelled: false }),
    ).toBe(0);
  });
});

describe('баланс книги долга', () => {
  it('пустая книга — ноль', () => {
    expect(debtBalance([])).toBe(0);
  });

  it('начисление и списание гасят друг друга', () => {
    expect(debtBalance([{ delta: 1 }, { delta: -1 }])).toBe(0);
  });

  it('списание без долга уходит в минус: это запас (§2.7)', () => {
    expect(debtBalance([{ delta: -1 }])).toBe(-1);
  });

  it('следующее «не выполнена» сначала съедает запас', () => {
    expect(debtBalance([{ delta: -1 }, { delta: 1 }])).toBe(0);
    expect(debtBalance([{ delta: -1 }, { delta: 1 }, { delta: 1 }])).toBe(1);
  });

  it('порог рейтинга и автозакрытие складываются в один счётчик', () => {
    expect(debtBalance([{ delta: 1 }, { delta: 1 }, { delta: 1 }])).toBe(3);
  });
});
