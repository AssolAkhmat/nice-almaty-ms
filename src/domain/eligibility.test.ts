import { describe, expect, it } from 'vitest';

import { parseEligibilityRule, resolveEligibility, type EligibilityMember } from './eligibility';

/**
 * Группы допуска (docs/03-BUSINESS-RULES.md §6.1).
 * Пример из требований: «двор: парни, кроме Азамата».
 */
const ROOM_1 = 'area-room-1';
const ROOM_2 = 'area-room-2';

const HOUSE: EligibilityMember[] = [
  { userId: 'azamat', sex: 'male', areaId: ROOM_1 },
  { userId: 'daniyar', sex: 'male', areaId: ROOM_1 },
  { userId: 'arman', sex: 'male', areaId: ROOM_2 },
  { userId: 'aliya', sex: 'female', areaId: ROOM_2 },
  { userId: 'gость-без-профиля', sex: null, areaId: null },
];

describe('разрешение группы допуска', () => {
  it('основа «все» берёт весь дом, включая тех, у кого пол не заполнен', () => {
    expect(resolveEligibility({ base: 'all' }, HOUSE)).toEqual([
      'azamat',
      'daniyar',
      'arman',
      'aliya',
      'gость-без-профиля',
    ]);
  });

  it('основа «парни» отбирает по полу', () => {
    expect(resolveEligibility({ base: 'male' }, HOUSE)).toEqual(['azamat', 'daniyar', 'arman']);
  });

  it('основа «девушки» отбирает по полу', () => {
    expect(resolveEligibility({ base: 'female' }, HOUSE)).toEqual(['aliya']);
  });

  it('пол не заполнен — человек не попадает ни в парней, ни в девушек', () => {
    const unknown = resolveEligibility({ base: 'male' }, HOUSE).concat(
      resolveEligibility({ base: 'female' }, HOUSE),
    );

    expect(unknown).not.toContain('gость-без-профиля');
  });

  it('основа «жильцы комнаты» берёт комнату целиком', () => {
    expect(resolveEligibility({ base: 'room', areaId: ROOM_1 }, HOUSE)).toEqual([
      'azamat',
      'daniyar',
    ]);
  });

  it('основа «жильцы комнаты» без комнаты — ошибка, а не пустая группа', () => {
    expect(() => resolveEligibility({ base: 'room' }, HOUSE)).toThrow(/комнат/);
  });

  it('пример §6.1: двор — парни, кроме Азамата', () => {
    expect(resolveEligibility({ base: 'male', excludeUserIds: ['azamat'] }, HOUSE)).toEqual([
      'daniyar',
      'arman',
    ]);
  });

  it('включение добавляет сверх основы', () => {
    expect(resolveEligibility({ base: 'female', includeUserIds: ['daniyar'] }, HOUSE)).toEqual([
      'daniyar',
      'aliya',
    ]);
  });

  it('исключение сильнее включения: спор решается в пользу запрета', () => {
    expect(
      resolveEligibility(
        { base: 'all', includeUserIds: ['azamat'], excludeUserIds: ['azamat'] },
        HOUSE,
      ),
    ).not.toContain('azamat');
  });

  it('включённый, но уже съехавший в списке не появляется', () => {
    expect(resolveEligibility({ base: 'female', includeUserIds: ['bolat'] }, HOUSE)).toEqual([
      'aliya',
    ]);
  });

  it('порядок повторяет порядок жильцов дома, а не порядок списков в правиле', () => {
    expect(
      resolveEligibility({ base: 'female', includeUserIds: ['arman', 'azamat'] }, HOUSE),
    ).toEqual(['azamat', 'arman', 'aliya']);
  });

  it('группа может оказаться пустой: это решение админа, а не ошибка', () => {
    expect(resolveEligibility({ base: 'female', excludeUserIds: ['aliya'] }, HOUSE)).toEqual([]);
  });
});

describe('разбор правила из базы', () => {
  it('минимальное правило приводится к полному виду', () => {
    expect(parseEligibilityRule({ base: 'all' })).toEqual({
      base: 'all',
      areaId: null,
      includeUserIds: [],
      excludeUserIds: [],
    });
  });

  it('правило целиком читается из jsonb', () => {
    expect(
      parseEligibilityRule({
        base: 'room',
        areaId: ROOM_1,
        includeUserIds: ['azamat'],
        excludeUserIds: ['daniyar'],
      }),
    ).toEqual({
      base: 'room',
      areaId: ROOM_1,
      includeUserIds: ['azamat'],
      excludeUserIds: ['daniyar'],
    });
  });

  it('незнакомая основа — ошибка: молча пустить всех нельзя', () => {
    expect(() => parseEligibilityRule({ base: 'everyone' })).toThrow(/основа/);
  });

  it('не объект — ошибка', () => {
    expect(() => parseEligibilityRule(null)).toThrow(/Правило допуска/);
    expect(() => parseEligibilityRule('male')).toThrow(/Правило допуска/);
  });

  it('списки не из строк — ошибка', () => {
    expect(() => parseEligibilityRule({ base: 'all', includeUserIds: [1] })).toThrow(
      /includeUserIds/,
    );
    expect(() => parseEligibilityRule({ base: 'all', excludeUserIds: {} })).toThrow(
      /excludeUserIds/,
    );
  });
});
