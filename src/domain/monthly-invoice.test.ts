import { describe, expect, it } from 'vitest';

import { parseBusinessDate } from '@/lib/time';

import { buildMonthlyInvoice, rentForMonth } from './monthly-invoice';

/**
 * Месячный счёт (docs/03-BUSINESS-RULES.md §3).
 *
 * Штрафы и скидка за рейтинг появятся в фазе 5 — их источников ещё нет,
 * и счёт собирается без них. Всё остальное из таблицы §3 здесь.
 */
const SEPTEMBER = parseBusinessDate('2026-09-01');

describe('цена проживания за месяц', () => {
  it('берётся из назначения, действующего на первое число', () => {
    expect(
      rentForMonth(SEPTEMBER, [{ price: 70_000, from: parseBusinessDate('2026-06-01'), to: null }]),
    ).toBe(70_000);
  });

  it('смена цены внутри месяца на текущий счёт не влияет (§3)', () => {
    // Место сменили 15 сентября: сентябрь считается по цене, что была 1 числа.
    expect(
      rentForMonth(SEPTEMBER, [
        {
          price: 70_000,
          from: parseBusinessDate('2026-06-01'),
          to: parseBusinessDate('2026-09-15'),
        },
        { price: 90_000, from: parseBusinessDate('2026-09-15'), to: null },
      ]),
    ).toBe(70_000);
  });

  it('новая цена действует со следующего месяца', () => {
    expect(
      rentForMonth(parseBusinessDate('2026-10-01'), [
        {
          price: 70_000,
          from: parseBusinessDate('2026-06-01'),
          to: parseBusinessDate('2026-09-15'),
        },
        { price: 90_000, from: parseBusinessDate('2026-09-15'), to: null },
      ]),
    ).toBe(90_000);
  });

  it('места на первое число не было — платить не за что', () => {
    expect(
      rentForMonth(SEPTEMBER, [{ price: 70_000, from: parseBusinessDate('2026-09-10'), to: null }]),
    ).toBe(0);
  });
});

describe('состав месячного счёта', () => {
  it('проживание идёт полной суммой, даже если жилец отсутствовал', () => {
    const invoice = buildMonthlyInvoice({ month: SEPTEMBER, rent: 70_000 });

    expect(invoice.lines).toEqual([{ kind: 'rent', title: 'Проживание', amount: 70_000 }]);
    expect(invoice.total).toBe(70_000);
  });

  it('коммуналка прошлого месяца добавляется отдельной строкой', () => {
    const invoice = buildMonthlyInvoice({
      month: SEPTEMBER,
      rent: 70_000,
      utilities: { amount: 5_410, title: 'Коммунальные услуги за август' },
    });

    expect(invoice.lines[1]).toEqual({
      kind: 'utilities',
      title: 'Коммунальные услуги за август',
      amount: 5_410,
    });
    expect(invoice.total).toBe(75_410);
  });

  it('незакрытый период коммуналки строки не даёт (§4.2)', () => {
    const invoice = buildMonthlyInvoice({ month: SEPTEMBER, rent: 70_000, utilities: null });

    expect(invoice.lines.some((line) => line.kind === 'utilities')).toBe(false);
  });

  it('отрицательный депозит переносится строкой погашения (§2.4)', () => {
    const invoice = buildMonthlyInvoice({ month: SEPTEMBER, rent: 70_000, depositDebt: 15_000 });

    expect(invoice.lines[1]).toEqual({
      kind: 'damage_carryover',
      title: 'Погашение перерасхода депозита',
      amount: 15_000,
    });
    expect(invoice.total).toBe(85_000);
  });

  it('нулевой долг депозита строки не создаёт', () => {
    const invoice = buildMonthlyInvoice({ month: SEPTEMBER, rent: 70_000, depositDebt: 0 });

    expect(invoice.lines).toHaveLength(1);
  });

  it('ручные начисления идут последними и в исходном порядке', () => {
    const invoice = buildMonthlyInvoice({
      month: SEPTEMBER,
      rent: 70_000,
      manualLines: [
        { title: 'Доплата за дни до 1 числа', amount: 12_000 },
        { title: 'Замок', amount: 3_000 },
      ],
    });

    expect(invoice.lines.map((line) => line.title)).toEqual([
      'Проживание',
      'Доплата за дни до 1 числа',
      'Замок',
    ]);
    expect(invoice.total).toBe(85_000);
  });

  it('нулевая цена места счёт не отменяет: у админа проживание бесплатное', () => {
    const invoice = buildMonthlyInvoice({ month: SEPTEMBER, rent: 0 });

    expect(invoice.lines).toEqual([{ kind: 'rent', title: 'Проживание', amount: 0 }]);
    expect(invoice.total).toBe(0);
  });

  it('итог всегда равен сумме строк — инвариант 5 из модели данных', () => {
    const invoice = buildMonthlyInvoice({
      month: SEPTEMBER,
      rent: 70_000,
      utilities: { amount: 5_410, title: 'Коммунальные услуги за август' },
      depositDebt: 1_000,
      manualLines: [{ title: 'Замок', amount: 3_000 }],
    });

    expect(invoice.total).toBe(invoice.lines.reduce((sum, line) => sum + line.amount, 0));
  });

  it('дробные и отрицательные суммы не принимаются: деньги — целые тенге', () => {
    expect(() => buildMonthlyInvoice({ month: SEPTEMBER, rent: 70_000.5 })).toThrow(/тенге/i);
    expect(() =>
      buildMonthlyInvoice({
        month: SEPTEMBER,
        rent: 70_000,
        manualLines: [{ title: 'Ошибка', amount: -1 }],
      }),
    ).toThrow(/тенге/i);
  });
});

describe('штрафы и скидка за рейтинг (§3, §5.4)', () => {
  it('штрафы идут отдельными строками в порядке начисления', () => {
    const draft = buildMonthlyInvoice({
      month: parseBusinessDate('2026-10-01'),
      rent: 100_000,
      fines: [
        { title: 'Штраф: рейтинг ниже 30', amount: 2_500 },
        { title: 'Штраф: рейтинг ниже 20', amount: 5_000 },
      ],
    });

    expect(draft.lines.map((line) => [line.kind, line.amount])).toEqual([
      ['rent', 100_000],
      ['fine', 2_500],
      ['fine', 5_000],
    ]);
    expect(draft.total).toBe(107_500);
  });

  it('скидка идёт последней строкой и вычитается', () => {
    const draft = buildMonthlyInvoice({
      month: parseBusinessDate('2026-10-01'),
      rent: 100_000,
      discount: { title: 'Скидка за рейтинг', amount: 2_500 },
    });

    expect(draft.lines[draft.lines.length - 1]).toEqual({
      kind: 'discount',
      title: 'Скидка за рейтинг',
      amount: -2_500,
    });
    expect(draft.total).toBe(97_500);
  });

  it('скидка не делает проживание отрицательным (§5.4)', () => {
    const draft = buildMonthlyInvoice({
      month: parseBusinessDate('2026-10-01'),
      rent: 2_000,
      utilities: { amount: 12_000, title: 'Коммуналка' },
      discount: { title: 'Скидка за рейтинг', amount: 5_000 },
    });

    // Скидка режется до цены проживания: коммуналку и штрафы она не уменьшает.
    expect(draft.lines[draft.lines.length - 1]?.amount).toBe(-2_000);
    expect(draft.total).toBe(12_000);
  });

  it('нулевая скидка строки не создаёт', () => {
    const draft = buildMonthlyInvoice({
      month: parseBusinessDate('2026-10-01'),
      rent: 100_000,
      discount: { title: 'Скидка за рейтинг', amount: 0 },
    });

    expect(draft.lines.map((line) => line.kind)).toEqual(['rent']);
  });
});
