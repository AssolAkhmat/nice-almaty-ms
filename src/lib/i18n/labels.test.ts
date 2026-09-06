import { describe, expect, it } from 'vitest';

import { auditEntityLabel } from './labels';

/**
 * Негативная фикстура к правилу «журнал не падает на незнакомой сущности».
 * До этого экран аудита рушился целиком, стоило появиться записи о зоне
 * или счёте: ключа в словаре не было, а перевод спрашивался напрямую.
 */
const dictionary = new Map([['audit.entities.house', 'Дом']]);

const source = {
  has: (key: string) => dictionary.has(key),
  get: (key: string) => dictionary.get(key) ?? '',
};

describe('подпись сущности в журнале', () => {
  it('известная сущность называется словами', () => {
    expect(auditEntityLabel('house', source)).toBe('Дом');
  });

  it('незнакомая показывается кодом, а не роняет экран', () => {
    expect(auditEntityLabel('area', source)).toBe('area');
  });
});
