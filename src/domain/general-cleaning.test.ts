import { describe, expect, it } from 'vitest';

import { parseBusinessDate } from '@/lib/time';

import { distributeGeneralCleaning, lastSundayOfMonth, type GeneralZone } from './general-cleaning';

/**
 * Генеральная уборка (docs/03-BUSINESS-RULES.md §6.5).
 * Распределение случайное, но детерминированное по сиду: дом и дата.
 */
const HOUSE = '7f0b7d3a-0000-4000-8000-000000000001';
const SEED = `${HOUSE}|2026-09-27`;

function zone(areaId: string, peopleNeeded: number, eligible: readonly string[]): GeneralZone {
  return { areaId, checklistId: `checklist-${areaId}`, peopleNeeded, eligibleUserIds: eligible };
}

const EVERYONE = ['azamat', 'daniyar', 'arman', 'aliya', 'bota', 'admin'];

describe('последнее воскресенье месяца', () => {
  it('сентябрь 2026 — двадцать седьмое', () => {
    expect(lastSundayOfMonth(parseBusinessDate('2026-09-15'))).toBe('2026-09-27');
  });

  it('месяц, который кончается воскресеньем, отдаёт свой последний день', () => {
    // 31 мая 2026 — воскресенье.
    expect(lastSundayOfMonth(parseBusinessDate('2026-05-01'))).toBe('2026-05-31');
  });

  it('февраль високосного года считается тем же правилом', () => {
    expect(lastSundayOfMonth(parseBusinessDate('2028-02-10'))).toBe('2028-02-27');
  });
});

describe('распределение генеральной уборки', () => {
  const zones = [
    zone('hall', 2, EVERYONE),
    zone('kitchen', 1, EVERYONE),
    zone('yard', 1, EVERYONE),
  ];

  it('раздаёт каждой зоне столько людей, сколько требует чек-лист', () => {
    const result = distributeGeneralCleaning(SEED, zones, EVERYONE);

    expect(result.map((item) => item.userIds.length)).toEqual([2, 1, 1]);
    expect(result.every((item) => item.userIds.every((userId) => userId !== null))).toBe(true);
  });

  it('один человек убирает не больше одной зоны', () => {
    const result = distributeGeneralCleaning(SEED, zones, EVERYONE);
    const assigned = result.flatMap((item) => item.userIds);

    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('один и тот же сид даёт один и тот же расклад', () => {
    expect(distributeGeneralCleaning(SEED, zones, EVERYONE)).toEqual(
      distributeGeneralCleaning(SEED, zones, EVERYONE),
    );
  });

  it('другая дата — другой расклад', () => {
    const other = distributeGeneralCleaning(`${HOUSE}|2026-10-25`, zones, EVERYONE);

    expect(other).not.toEqual(distributeGeneralCleaning(SEED, zones, EVERYONE));
  });

  it('порядок людей на входе на расклад не влияет', () => {
    const reversed = [...EVERYONE].reverse();

    expect(distributeGeneralCleaning(SEED, zones, reversed)).toEqual(
      distributeGeneralCleaning(SEED, zones, EVERYONE),
    );
  });

  it('в уборке участвуют все жильцы дома, включая админа', () => {
    const single = [zone('hall', 6, EVERYONE)];
    const result = distributeGeneralCleaning(SEED, single, EVERYONE);

    expect([...(result[0]?.userIds ?? [])].sort()).toEqual([...EVERYONE].sort());
  });

  it('группа допуска сужает круг: двор достаётся только парням', () => {
    const boys = ['azamat', 'daniyar', 'arman'];
    const result = distributeGeneralCleaning(SEED, [zone('yard', 2, boys)], EVERYONE);

    expect(result[0]?.userIds.every((userId) => userId !== null && boys.includes(userId))).toBe(
      true,
    );
  });

  it('людей не хватило — место остаётся пустым, а не исчезает', () => {
    const result = distributeGeneralCleaning(
      SEED,
      [zone('hall', 3, EVERYONE)],
      ['azamat', 'daniyar'],
    );

    expect(result[0]?.userIds).toHaveLength(3);
    expect(result[0]?.userIds.filter((userId) => userId === null)).toHaveLength(1);
  });

  it('никто не допущен — зона остаётся без исполнителей, но в списке', () => {
    const result = distributeGeneralCleaning(SEED, [zone('yard', 1, [])], EVERYONE);

    expect(result[0]?.userIds).toEqual([null]);
  });

  it('зона с people_needed меньше единицы — ошибка', () => {
    expect(() => distributeGeneralCleaning(SEED, [zone('yard', 0, EVERYONE)], EVERYONE)).toThrow(
      /people_needed/,
    );
  });

  it('сначала занимаются те, кому зона доступна только одна', () => {
    // Двор открыт одному Азамату; зал — всем. Азамат обязан достаться двору,
    // иначе двор останется пустым при полном доме.
    const result = distributeGeneralCleaning(
      SEED,
      [zone('hall', 1, EVERYONE), zone('yard', 1, ['azamat'])],
      EVERYONE,
    );

    expect(result[1]?.userIds).toEqual(['azamat']);
    expect(result[0]?.userIds).not.toContain('azamat');
  });
});
