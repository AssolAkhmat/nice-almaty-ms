import { describe, expect, it } from 'vitest';

import { isNormalizedPhone, normalizePhone, tryNormalizePhone } from './phone';

/**
 * Формат хранения — `+7XXXXXXXXXX` (docs/02-DATA-MODEL.md, docs/01-ARCHITECTURE.md).
 * Логин идёт по телефону, поэтому нормализация обязана быть однозначной:
 * один и тот же человек не должен завести два аккаунта из-за формы записи.
 */
describe('нормализация телефона', () => {
  it('приводит все привычные формы записи к одному значению', () => {
    const expected = '+77011234567';

    for (const input of [
      '+77011234567',
      '87011234567',
      '77011234567',
      '7011234567',
      '+7 (701) 123-45-67',
      '8 701 123 45 67',
      '8-701-123-45-67',
      ' +7 701 123 45 67 ',
    ]) {
      expect(normalizePhone(input), input).toBe(expected);
    }
  });

  it('нормализация идемпотентна', () => {
    const once = normalizePhone('87019998877');

    expect(normalizePhone(once)).toBe(once);
  });

  it('различает разные номера', () => {
    expect(normalizePhone('87011234567')).not.toBe(normalizePhone('87011234568'));
  });

  describe('отвергает то, что не является казахстанским номером', () => {
    it('слишком короткий', () => {
      expect(() => normalizePhone('701123456')).toThrow(/номер/i);
    });

    it('слишком длинный', () => {
      expect(() => normalizePhone('770112345678')).toThrow(/номер/i);
    });

    it('чужой код страны', () => {
      expect(() => normalizePhone('+996701123456')).toThrow(/номер/i);
      expect(() => normalizePhone('+12025550100')).toThrow(/номер/i);
    });

    it('пустая строка и мусор', () => {
      expect(() => normalizePhone('')).toThrow(/номер/i);
      expect(() => normalizePhone('телефон')).toThrow(/номер/i);
      expect(() => normalizePhone('++77011234567')).toThrow(/номер/i);
    });

    it('десятизначный номер, не начинающийся с семёрки', () => {
      // Казахстанские мобильные начинаются с 7: 701, 705, 747, 771, 777 и т. д.
      expect(() => normalizePhone('6011234567')).toThrow(/номер/i);
    });
  });

  it('мягкий вариант возвращает null вместо исключения', () => {
    expect(tryNormalizePhone('87011234567')).toBe('+77011234567');
    expect(tryNormalizePhone('мусор')).toBeNull();
  });

  it('проверка формата хранения', () => {
    expect(isNormalizedPhone('+77011234567')).toBe(true);
    expect(isNormalizedPhone('87011234567')).toBe(false);
    expect(isNormalizedPhone('+7701123456')).toBe(false);
  });
});
