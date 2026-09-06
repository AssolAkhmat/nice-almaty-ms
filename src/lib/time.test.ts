import { describe, expect, it } from 'vitest';

import {
  ALMATY_TIME_ZONE,
  ALMATY_UTC_OFFSET_MINUTES,
  addDays,
  businessDate,
  compareBusinessDates,
  daysInMonth,
  differenceInDays,
  endOfMonth,
  minusMilliseconds,
  now,
  plusMilliseconds,
  parseBusinessDate,
  startOfDayUtc,
  startOfMonth,
  startOfNextDayUtc,
  todayInAlmaty,
  toAlmatyParts,
} from './time';

/**
 * Правила из docs/03-BUSINESS-RULES.md §0 и docs/01-ARCHITECTURE.md:
 * зона Asia/Almaty — UTC+5 без переходов на летнее время;
 * календарные сутки — [00:00, 24:00) местного времени.
 */
describe('зона Asia/Almaty', () => {
  it('смещение — ровно +5 часов', () => {
    expect(ALMATY_TIME_ZONE).toBe('Asia/Almaty');
    expect(ALMATY_UTC_OFFSET_MINUTES).toBe(300);
  });

  it('переходов на летнее время нет: январь и июль дают одно смещение', () => {
    const winter = toAlmatyParts(new Date('2027-01-15T00:00:00Z'));
    const summer = toAlmatyParts(new Date('2027-07-15T00:00:00Z'));

    expect(winter.hour).toBe(5);
    expect(summer.hour).toBe(5);
  });
});

describe('todayInAlmaty', () => {
  it('18:59:59Z — это ещё 6 сентября, 23:59:59 по Алматы', () => {
    expect(todayInAlmaty(new Date('2026-09-06T18:59:59Z'))).toBe('2026-09-06');
  });

  it('19:00:00Z — уже 7 сентября, 00:00 по Алматы', () => {
    expect(todayInAlmaty(new Date('2026-09-06T19:00:00Z'))).toBe('2026-09-07');
  });

  it('комендантский час 23:00 наступает в 18:00Z', () => {
    const parts = toAlmatyParts(new Date('2026-09-06T18:00:00Z'));

    expect(parts.hour).toBe(23);
    expect(parts.minute).toBe(0);
    expect(parts.day).toBe(6);
  });
});

describe('границы суток', () => {
  it('сутки начинаются в 19:00Z предыдущего дня', () => {
    expect(startOfDayUtc(businessDate(2026, 9, 6)).toISOString()).toBe('2026-09-05T19:00:00.000Z');
  });

  it('верхняя граница исключающая: следующие сутки начинаются в 19:00Z', () => {
    expect(startOfNextDayUtc(businessDate(2026, 9, 6)).toISOString()).toBe(
      '2026-09-06T19:00:00.000Z',
    );
  });

  it('автозакрытие ротаций в 23:55 по Алматы — это 18:55Z', () => {
    const parts = toAlmatyParts(new Date('2026-09-06T18:55:00Z'));

    expect(parts.hour).toBe(23);
    expect(parts.minute).toBe(55);
  });

  it('генерация счетов 1 числа в 00:05 по Алматы — это 19:05Z прошлого месяца', () => {
    const parts = toAlmatyParts(new Date('2026-08-31T19:05:00Z'));

    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(9);
    expect(parts.day).toBe(1);
    expect(parts.hour).toBe(0);
    expect(parts.minute).toBe(5);
  });
});

describe('бизнес-даты', () => {
  it('разбирает строку YYYY-MM-DD', () => {
    expect(parseBusinessDate('2026-09-06')).toBe('2026-09-06');
  });

  it('дополняет нулями', () => {
    expect(businessDate(2027, 2, 1)).toBe('2027-02-01');
  });

  it('отвергает мусор и несуществующие даты', () => {
    expect(() => parseBusinessDate('06.09.2026')).toThrow(/дата/i);
    expect(() => parseBusinessDate('2026-13-01')).toThrow(/дата/i);
    expect(() => parseBusinessDate('2027-02-29')).toThrow(/дата/i);
    expect(() => parseBusinessDate('2026-09-06T00:00:00Z')).toThrow(/дата/i);
  });

  it('сравнивает даты лексикографически и хронологически одинаково', () => {
    expect(compareBusinessDates(businessDate(2026, 9, 6), businessDate(2026, 9, 7))).toBeLessThan(
      0,
    );
    expect(
      compareBusinessDates(businessDate(2026, 10, 1), businessDate(2026, 9, 30)),
    ).toBeGreaterThan(0);
    expect(compareBusinessDates(businessDate(2026, 9, 6), businessDate(2026, 9, 6))).toBe(0);
  });
});

describe('месяцы', () => {
  it('начало и конец месяца', () => {
    expect(startOfMonth(businessDate(2026, 9, 6))).toBe('2026-09-01');
    expect(endOfMonth(businessDate(2026, 9, 6))).toBe('2026-09-30');
  });

  it('февраль невисокосного и високосного года', () => {
    expect(endOfMonth(businessDate(2027, 2, 15))).toBe('2027-02-28');
    expect(endOfMonth(businessDate(2028, 2, 15))).toBe('2028-02-29');
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it('длина месяцев учебного года', () => {
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(daysInMonth(2026, 10)).toBe(31);
    expect(daysInMonth(2026, 11)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('арифметика дней', () => {
  it('прибавление дней с переходом через месяц и год', () => {
    expect(addDays(businessDate(2026, 8, 31), 1)).toBe('2026-09-01');
    expect(addDays(businessDate(2026, 12, 31), 1)).toBe('2027-01-01');
    expect(addDays(businessDate(2028, 2, 28), 1)).toBe('2028-02-29');
  });

  it('вычитание дней', () => {
    expect(addDays(businessDate(2026, 9, 1), -1)).toBe('2026-08-31');
  });

  it('30 дней на возврат депозита от даты расторжения (§2.3)', () => {
    expect(addDays(businessDate(2026, 12, 10), 30)).toBe('2027-01-09');
  });

  it('разница в днях', () => {
    expect(differenceInDays(businessDate(2026, 9, 1), businessDate(2026, 9, 30))).toBe(29);
    expect(differenceInDays(businessDate(2026, 9, 30), businessDate(2026, 9, 1))).toBe(-29);
    expect(differenceInDays(businessDate(2026, 9, 1), businessDate(2026, 9, 1))).toBe(0);
  });
});

describe('сдвиг момента времени', () => {
  it('вперёд и назад на миллисекунды', () => {
    const instant = new Date('2026-09-06T12:00:00.000Z');

    expect(plusMilliseconds(instant, 1000).toISOString()).toBe('2026-09-06T12:00:01.000Z');
    expect(minusMilliseconds(instant, 1000).toISOString()).toBe('2026-09-06T11:59:59.000Z');
  });

  it('окно ограничения попыток входа — пятнадцать минут назад', () => {
    const instant = new Date('2026-09-06T12:00:00.000Z');
    const windowStart = minusMilliseconds(instant, 15 * 60 * 1000);

    expect(windowStart.toISOString()).toBe('2026-09-06T11:45:00.000Z');
  });

  it('не меняет исходный момент', () => {
    const instant = new Date('2026-09-06T12:00:00.000Z');
    plusMilliseconds(instant, 5000);

    expect(instant.toISOString()).toBe('2026-09-06T12:00:00.000Z');
  });
});

describe('now', () => {
  it('возвращает момент времени', () => {
    expect(now()).toBeInstanceOf(Date);
  });
});
