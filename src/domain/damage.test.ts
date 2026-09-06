import { describe, expect, it } from 'vitest';

import { resolveDamageParticipants, splitDamage } from './damage';

/**
 * Ущерб (docs/03-BUSINESS-RULES.md §8, docs/04-MODULES/07-damages.md).
 * Пример 8.1 — числами: 1 800 ₸ на 18 из 20 участников.
 */
const ROSTER = [
  { userId: 'admin', areaId: 'room-1' },
  { userId: 'a', areaId: 'room-1' },
  { userId: 'b', areaId: 'room-1' },
  { userId: 'c', areaId: 'room-2' },
  { userId: 'd', areaId: null },
];

describe('кто участвует в делении', () => {
  it('один человек — только он', () => {
    expect(
      resolveDamageParticipants({ mode: 'single', config: { userIds: ['b'] } }, ROSTER),
    ).toEqual(['b']);
  });

  it('по комнате — все жильцы этой комнаты', () => {
    expect(
      resolveDamageParticipants({ mode: 'room', config: { areaId: 'room-1' } }, ROSTER),
    ).toEqual(['admin', 'a', 'b']);
  });

  it('все — весь дом, включая админа: он тоже живёт', () => {
    expect(resolveDamageParticipants({ mode: 'all', config: {} }, ROSTER)).toEqual([
      'admin',
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('все, кроме выбранных — типовой случай «кроме админа»', () => {
    expect(
      resolveDamageParticipants(
        { mode: 'all_except', config: { userIds: ['admin', 'a'] } },
        ROSTER,
      ),
    ).toEqual(['b', 'c', 'd']);
  });

  it('произвольный список берёт только тех, кто живёт в доме', () => {
    expect(
      resolveDamageParticipants(
        { mode: 'custom', config: { userIds: ['a', 'c', 'посторонний'] } },
        ROSTER,
      ),
    ).toEqual(['a', 'c']);
  });

  it('пустой список участников — ошибка, а не молчаливое деление ни на кого', () => {
    expect(() =>
      resolveDamageParticipants({ mode: 'custom', config: { userIds: [] } }, ROSTER),
    ).toThrow(/участник/i);
  });

  it('комната без жильцов участников не даёт', () => {
    expect(() =>
      resolveDamageParticipants({ mode: 'room', config: { areaId: 'room-9' } }, ROSTER),
    ).toThrow(/участник/i);
  });
});

describe('деление суммы ущерба', () => {
  it('пример 8.1: 1 800 ₸ на 18 участников — по 100 ₸, излишка нет', () => {
    const participants = Array.from({ length: 18 }, (_, index) => `user-${String(index)}`);
    const result = splitDamage(1_800, participants);

    expect(result.shares.every((share) => share.amount === 100)).toBe(true);
    expect(result.surplus).toBe(0);
  });

  it('пример 0.1: 1 800 ₸ на 17 участников — по 106 ₸, излишек 2 ₸ дому', () => {
    const participants = Array.from({ length: 17 }, (_, index) => `user-${String(index)}`);
    const result = splitDamage(1_800, participants);

    expect(result.shares.every((share) => share.amount === 106)).toBe(true);
    expect(result.surplus).toBe(2);
  });

  it('доля списывается с каждого участника поимённо', () => {
    const result = splitDamage(300, ['a', 'b', 'c']);

    expect(result.shares).toEqual([
      { userId: 'a', amount: 100 },
      { userId: 'b', amount: 100 },
      { userId: 'c', amount: 100 },
    ]);
  });
});
