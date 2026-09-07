import { describe, expect, it } from 'vitest';

import { allocatePayment, depositBalance, invoiceStatus, remainingToPay } from './invoice';

/**
 * Счёт и остаток депозита (docs/02-DATA-MODEL.md, docs/03-BUSINESS-RULES.md §3).
 *
 * Полная машинерия счетов — фаза 3; здесь ровно то, что нужно депозиту:
 * остаток как сумма движений и статус счёта по внесённым платежам.
 * Частичная оплата разрешена (§3), поэтому статусов три, а не два.
 */
describe('остаток депозита', () => {
  it('пустой список движений — ноль, а не отсутствие значения', () => {
    expect(depositBalance([])).toBe(0);
  });

  it('сумма движений со знаком', () => {
    expect(depositBalance([45_000, -1_800, -100])).toBe(43_100);
  });

  it('ущерб может увести остаток в минус (§2.4)', () => {
    expect(depositBalance([45_000, -50_000])).toBe(-5_000);
  });

  it('возврат обнуляет остаток', () => {
    expect(depositBalance([45_000, -45_000])).toBe(0);
  });
});

describe('статус счёта по платежам', () => {
  it('без платежей счёт остаётся выставленным', () => {
    expect(invoiceStatus(45_000, 0)).toBe('issued');
  });

  it('часть суммы — частично оплачен', () => {
    expect(invoiceStatus(45_000, 30_000)).toBe('partially_paid');
  });

  it('вся сумма — оплачен', () => {
    expect(invoiceStatus(45_000, 45_000)).toBe('paid');
  });

  it('переплата тоже считается оплатой, а не новым состоянием', () => {
    expect(invoiceStatus(45_000, 46_000)).toBe('paid');
  });

  it('счёт на ноль оплачен сразу: у админа депозит нулевой (§1.2)', () => {
    expect(invoiceStatus(0, 0)).toBe('paid');
  });
});

describe('сколько осталось внести', () => {
  it('разница между суммой счёта и платежами', () => {
    expect(remainingToPay(45_000, 30_000)).toBe(15_000);
  });

  it('переплата не даёт отрицательного остатка', () => {
    expect(remainingToPay(45_000, 46_000)).toBe(0);
  });
});

/**
 * Куда платёж попадает в книге проводок (§10.1). Частичная оплата — норма
 * (§3), поэтому распределение обязано быть определённым при любой сумме:
 * иначе деньги поставщика и восстановленный депозит зависели бы от того,
 * в каком порядке жилец занёс тысячи.
 */
describe('распределение платежа по фондам', () => {
  const lines = [
    { kind: 'rent' as const, amount: 90_000 },
    { kind: 'utilities' as const, amount: 12_000 },
    { kind: 'damage_carryover' as const, amount: 5_000 },
    { kind: 'extra' as const, amount: 3_000 },
  ];

  it('первым закрывается коммунальный фонд: это деньги поставщика', () => {
    expect(allocatePayment(lines, 0, 10_000)).toEqual({
      utilities: 10_000,
      deposit: 0,
      house: 0,
    });
  });

  it('следом восстанавливается депозит, потом идёт фонд дома', () => {
    expect(allocatePayment(lines, 0, 20_000)).toEqual({
      utilities: 12_000,
      deposit: 5_000,
      house: 3_000,
    });
  });

  it('второй платёж продолжает с того места, где кончился первый', () => {
    expect(allocatePayment(lines, 12_000, 8_000)).toEqual({
      utilities: 0,
      deposit: 5_000,
      house: 3_000,
    });
  });

  it('полная оплата разносит счёт целиком', () => {
    const all = allocatePayment(lines, 0, 110_000);

    expect(all).toEqual({ utilities: 12_000, deposit: 5_000, house: 93_000 });
    expect(all.utilities + all.deposit + all.house).toBe(110_000);
  });

  it('сумма разнесённого всегда равна платежу: проводка обязана сойтись', () => {
    for (const amount of [1, 999, 12_001, 109_999]) {
      const split = allocatePayment(lines, 0, amount);

      expect(split.utilities + split.deposit + split.house).toBe(amount);
    }
  });

  it('счёт без коммуналки и перерасхода уходит в фонд дома целиком', () => {
    expect(allocatePayment([{ kind: 'rent', amount: 90_000 }], 0, 90_000)).toEqual({
      utilities: 0,
      deposit: 0,
      house: 90_000,
    });
  });
});
