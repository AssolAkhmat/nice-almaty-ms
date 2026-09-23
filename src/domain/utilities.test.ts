import { describe, expect, it } from 'vitest';

import { parseBusinessDate } from '@/lib/time';

import {
  absentDaysInMonth,
  daysLivedInHouseInMonth,
  daysLivedInMonth,
  distributeUtilities,
  monthOptions,
  parseMonthInput,
} from './utilities';

/**
 * Коммунальные услуги: числовые примеры из docs/03-BUSINESS-RULES.md §4.2.
 * Доля округляется вверх, излишек остаётся дому (§0).
 */
const SEPTEMBER = parseBusinessDate('2026-09-01');

describe('дни проживания в месяце', () => {
  it('полный месяц засчитывается целиком', () => {
    expect(
      daysLivedInMonth({
        month: SEPTEMBER,
        moveIn: parseBusinessDate('2026-06-01'),
        moveOut: null,
      }),
    ).toBe(30);
  });

  it('день заезда прожит: заезд 21 сентября даёт десять дней', () => {
    expect(
      daysLivedInMonth({
        month: SEPTEMBER,
        moveIn: parseBusinessDate('2026-09-21'),
        moveOut: null,
      }),
    ).toBe(10);
  });

  it('день выезда прожит: выезд 10 сентября даёт десять дней', () => {
    expect(
      daysLivedInMonth({
        month: SEPTEMBER,
        moveIn: parseBusinessDate('2026-06-01'),
        moveOut: parseBusinessDate('2026-09-10'),
      }),
    ).toBe(10);
  });

  it('проживание вне месяца не даёт ни дня', () => {
    expect(
      daysLivedInMonth({
        month: SEPTEMBER,
        moveIn: parseBusinessDate('2026-10-01'),
        moveOut: null,
      }),
    ).toBe(0);

    expect(
      daysLivedInMonth({
        month: SEPTEMBER,
        moveIn: parseBusinessDate('2026-06-01'),
        moveOut: parseBusinessDate('2026-08-31'),
      }),
    ).toBe(0);
  });

  it('без даты заезда дней нет: проживание ещё не началось', () => {
    expect(daysLivedInMonth({ month: SEPTEMBER, moveIn: null, moveOut: null })).toBe(0);
  });
});

describe('вычет дней долгосрочного отсутствия', () => {
  it('пример 4.3: уехал 10-го, вернулся 14-го — не считаются 11, 12 и 13', () => {
    expect(
      absentDaysInMonth(SEPTEMBER, [
        { from: parseBusinessDate('2026-09-10'), to: parseBusinessDate('2026-09-14') },
      ]),
    ).toBe(3);
  });

  it('отъезд и возвращение подряд не дают ни одного вычитаемого дня', () => {
    expect(
      absentDaysInMonth(SEPTEMBER, [
        { from: parseBusinessDate('2026-09-10'), to: parseBusinessDate('2026-09-11') },
      ]),
    ).toBe(0);
  });

  it('отсутствие через границу месяца режется по месяцу', () => {
    // Уехал 28 сентября, вернулся 3 октября: в сентябре не считаются 29 и 30.
    expect(
      absentDaysInMonth(SEPTEMBER, [
        { from: parseBusinessDate('2026-09-28'), to: parseBusinessDate('2026-10-03') },
      ]),
    ).toBe(2);
  });

  it('несколько отсутствий складываются', () => {
    expect(
      absentDaysInMonth(SEPTEMBER, [
        { from: parseBusinessDate('2026-09-01'), to: parseBusinessDate('2026-09-05') },
        { from: parseBusinessDate('2026-09-20'), to: parseBusinessDate('2026-09-24') },
      ]),
    ).toBe(6);
  });
});

describe('распределение коммуналки (§4.2)', () => {
  it('пример 4.1: 30 000 на 10, 20 и 30 дней — 5 000 / 10 000 / 15 000, излишка нет', () => {
    const result = distributeUtilities(30_000, [
      { userId: 'a', days: 10 },
      { userId: 'b', days: 20 },
      { userId: 'c', days: 30 },
    ]);

    expect(result.allocations.map((allocation) => allocation.amount)).toEqual([
      5_000, 10_000, 15_000,
    ]);
    expect(result.surplus).toBe(0);
  });

  it('пример 4.2: 30 000 на 11, 20 и 30 дней — 5 410 / 9 837 / 14 755, излишек 2 ₸', () => {
    const result = distributeUtilities(30_000, [
      { userId: 'a', days: 11 },
      { userId: 'b', days: 20 },
      { userId: 'c', days: 30 },
    ]);

    expect(result.allocations.map((allocation) => allocation.amount)).toEqual([
      5_410, 9_837, 14_755,
    ]);
    expect(result.surplus).toBe(2);
  });

  it('жилец без дней в месяце в распределении не участвует', () => {
    const result = distributeUtilities(30_000, [
      { userId: 'a', days: 10 },
      { userId: 'b', days: 20 },
      { userId: 'c', days: 0 },
    ]);

    expect(result.allocations).toHaveLength(2);
    expect(result.allocations.map((allocation) => allocation.userId)).toEqual(['a', 'b']);
  });

  it('без единого прожитого дня делить нечего: пустое распределение, а не деление на ноль', () => {
    const result = distributeUtilities(30_000, [{ userId: 'a', days: 0 }]);

    expect(result.allocations).toEqual([]);
    // Разделить не на кого: вся сумма остаётся дому.
    expect(result.surplus).toBe(0);
    expect(result.undistributed).toBe(30_000);
  });

  it('нулевая коммуналка даёт нулевые доли, а не ошибку', () => {
    const result = distributeUtilities(0, [{ userId: 'a', days: 10 }]);

    expect(result.allocations).toEqual([{ userId: 'a', days: 10, amount: 0 }]);
    expect(result.surplus).toBe(0);
  });
});

describe('месяц периода из строки экрана', () => {
  it('поле выбора месяца отдаёт ГГГГ-ММ — это первое число месяца', () => {
    expect(parseMonthInput('2026-09')).toBe('2026-09-01');
  });

  it('полная дата из ссылки сводится к первому числу', () => {
    expect(parseMonthInput('2026-09-22')).toBe('2026-09-01');
  });

  it('пробелы по краям не мешают', () => {
    expect(parseMonthInput('  2026-09  ')).toBe('2026-09-01');
  });

  it('не месяц — пусто, а не догадка', () => {
    expect(parseMonthInput('')).toBeNull();
    expect(parseMonthInput('сентябрь')).toBeNull();
    expect(parseMonthInput('2026-13')).toBeNull();
    expect(parseMonthInput('2026')).toBeNull();
  });
});

/*
 * Негативная фикстура к сломанному месту: список месяцев на экране коммуналки
 * не содержал текущего месяца, поэтому 22 сентября сентябрь завести было
 * нельзя. Любая попытка снова вычислить список «на сколько-то назад»
 * краснеет здесь.
 */
describe('месяцы переключателя коммуналки', () => {
  it('текущий месяц есть всегда, даже когда ни одного периода не заведено', () => {
    expect(monthOptions(parseBusinessDate('2026-09-22'), [])).toEqual(['2026-09-01', '2026-08-01']);
  });

  it('текущий месяц есть и тогда, когда все периоды старые', () => {
    const months = monthOptions(parseBusinessDate('2026-09-22'), [
      parseBusinessDate('2026-06-01'),
      parseBusinessDate('2026-07-01'),
      parseBusinessDate('2026-08-01'),
    ]);

    expect(months).toContain('2026-09-01');
  });

  it('заведённый период не теряется, как бы давно он ни был', () => {
    const months = monthOptions(parseBusinessDate('2026-09-22'), [parseBusinessDate('2024-01-01')]);

    expect(months).toContain('2024-01-01');
  });

  it('порядок — от нового к старому, повторов нет', () => {
    const months = monthOptions(parseBusinessDate('2026-01-15'), [
      parseBusinessDate('2025-12-01'),
      parseBusinessDate('2026-01-01'),
      parseBusinessDate('2025-11-30'),
    ]);

    expect(months).toEqual(['2026-01-01', '2025-12-01', '2025-11-01']);
  });
});

/**
 * Дни в конкретном доме (решение D26). Главное свойство — для того, кто
 * никуда не переезжал, ответ обязан совпадать с прежним расчётом день
 * в день: правка не должна шевельнуть ни один существующий счёт.
 */
describe('дни месяца в конкретном доме', () => {
  const WHOLE = { month: SEPTEMBER, moveIn: parseBusinessDate('2026-01-01'), moveOut: null };

  it('без переезда отвечает ровно то же, что общий расчёт дней', () => {
    for (const moveIn of ['2026-01-01', '2026-09-01', '2026-09-11', '2026-09-30'] as const) {
      const range = { month: SEPTEMBER, moveIn: parseBusinessDate(moveIn), moveOut: null };

      expect(
        daysLivedInHouseInMonth({ ...range, stays: [], elsewhere: false, belongsNow: true }),
      ).toBe(daysLivedInMonth(range));
    }
  });

  it('чужой дом без переезда не получает ни дня', () => {
    expect(
      daysLivedInHouseInMonth({ ...WHOLE, stays: [], elsewhere: false, belongsNow: false }),
    ).toBe(0);
  });

  /*
   * Прошлый месяц после переселения: человек весь сентябрь стоял на месте
   * дома A, а числится теперь за домом B. Прежний расчёт отдал бы сентябрь
   * дому B, где его не было.
   */
  it('дом, где человек стоял на месте, получает месяц, даже если он уже съехал', () => {
    expect(
      daysLivedInHouseInMonth({
        ...WHOLE,
        stays: [{ from: parseBusinessDate('2026-08-01'), to: parseBusinessDate('2026-10-01') }],
        elsewhere: false,
        belongsNow: false,
      }),
    ).toBe(30);
  });

  /*
   * Месяц переселения. Прежний расчёт дал бы 30 дней и старому дому,
   * и новому: человек заплатил бы дважды за один сентябрь.
   */
  it('месяц переселения режется по отрезкам, и сумма дней равна месяцу', () => {
    const oldHouse = daysLivedInHouseInMonth({
      ...WHOLE,
      stays: [{ from: parseBusinessDate('2026-06-01'), to: parseBusinessDate('2026-09-10') }],
      elsewhere: true,
      belongsNow: false,
    });

    const newHouse = daysLivedInHouseInMonth({
      ...WHOLE,
      stays: [{ from: parseBusinessDate('2026-09-10'), to: null }],
      elsewhere: true,
      belongsNow: true,
    });

    expect(oldHouse).toBe(9);
    expect(newHouse).toBe(21);
    expect(oldHouse + newHouse).toBe(30);
  });

  it('день переселения засчитывается новому дому ровно один раз', () => {
    const on = parseBusinessDate('2026-09-10');

    const oldHouse = daysLivedInHouseInMonth({
      ...WHOLE,
      stays: [{ from: parseBusinessDate('2026-06-01'), to: on }],
      elsewhere: true,
      belongsNow: false,
    });
    const newHouse = daysLivedInHouseInMonth({
      ...WHOLE,
      stays: [{ from: on, to: null }],
      elsewhere: true,
      belongsNow: true,
    });

    // 1–9 сентября — старому дому, 10–30 — новому. Десятое не считается дважды.
    expect(oldHouse).toBe(9);
    expect(newHouse).toBe(21);
  });

  it('переезд в месяц заезда считается от дня заезда, а не от первого числа', () => {
    const range = { month: SEPTEMBER, moveIn: parseBusinessDate('2026-09-05'), moveOut: null };

    const oldHouse = daysLivedInHouseInMonth({
      ...range,
      stays: [{ from: parseBusinessDate('2026-09-05'), to: parseBusinessDate('2026-09-20') }],
      elsewhere: true,
      belongsNow: false,
    });
    const newHouse = daysLivedInHouseInMonth({
      ...range,
      stays: [{ from: parseBusinessDate('2026-09-20'), to: null }],
      elsewhere: true,
      belongsNow: true,
    });

    expect(oldHouse).toBe(15);
    expect(newHouse).toBe(11);
    expect(oldHouse + newHouse).toBe(daysLivedInMonth(range));
  });

  it('месяц без единого прожитого дня не даёт дней ни одному дому', () => {
    const range = { month: SEPTEMBER, moveIn: parseBusinessDate('2026-10-01'), moveOut: null };

    expect(
      daysLivedInHouseInMonth({ ...range, stays: [], elsewhere: true, belongsNow: true }),
    ).toBe(0);
  });
});
