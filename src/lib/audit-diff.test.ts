import { describe, expect, it } from 'vitest';

import { diffForAudit, isSensitiveField, MASKED_VALUE, snapshotForAudit } from './audit-diff';

describe('разница для журнала', () => {
  it('оставляет только изменившиеся поля', () => {
    const diff = diffForAudit(
      { name: 'Дом A', address: 'Абая 1', curfewTime: '23:00' },
      { name: 'Дом Б', address: 'Абая 1', curfewTime: '23:00' },
    );

    expect(diff).toEqual({ before: { name: 'Дом A' }, after: { name: 'Дом Б' } });
  });

  it('без изменений записи в журнале быть не должно', () => {
    expect(diffForAudit({ name: 'Дом A' }, { name: 'Дом A' })).toBeNull();
    expect(diffForAudit({}, {})).toBeNull();
  });

  it('видит появление и исчезновение поля', () => {
    expect(diffForAudit({}, { houseId: 'h-1' })).toEqual({
      before: {},
      after: { houseId: 'h-1' },
    });
    expect(diffForAudit({ houseId: 'h-1' }, {})).toEqual({
      before: { houseId: 'h-1' },
      after: {},
    });
  });

  it('различает null и отсутствие значения', () => {
    expect(diffForAudit({ houseId: 'h-1' }, { houseId: null })).toEqual({
      before: { houseId: 'h-1' },
      after: { houseId: null },
    });
  });

  it('сравнивает даты по моменту, а не по ссылке', () => {
    const before = { lastLoginAt: new Date('2026-09-06T00:00:00Z') };
    const same = { lastLoginAt: new Date('2026-09-06T00:00:00Z') };
    const other = { lastLoginAt: new Date('2026-09-07T00:00:00Z') };

    expect(diffForAudit(before, same)).toBeNull();
    expect(diffForAudit(before, other)?.after).toEqual({
      lastLoginAt: '2026-09-07T00:00:00.000Z',
    });
  });

  it('сравнивает вложенные значения по содержимому', () => {
    expect(diffForAudit({ value: { a: 1 } }, { value: { a: 1 } })).toBeNull();
    expect(diffForAudit({ value: { a: 1 } }, { value: { a: 2 } })).not.toBeNull();
  });
});

/**
 * Главное правило журнала: расшифрованные значения в него не попадают,
 * иначе аудит станет вторым, незашифрованным хранилищем персональных данных.
 */
describe('маскирование секретов', () => {
  it('узнаёт секретные поля', () => {
    for (const name of [
      'passwordHash',
      'password_hash',
      'password',
      'tokenHash',
      'iin',
      'iin_enc',
      'iinEnc',
      'id_doc_number_enc',
      'idDocNumber',
    ]) {
      expect(isSensitiveField(name), name).toBe(true);
    }
  });

  it('обычные поля секретными не считает', () => {
    for (const name of ['name', 'phone', 'iin_last4', 'role', 'encoding']) {
      expect(isSensitiveField(name), name).toBe(false);
    }
  });

  it('пишет факт изменения, но не значение', () => {
    const diff = diffForAudit(
      { iin_enc: 'старое зашифрованное', name: 'Иван' },
      { iin_enc: 'новое зашифрованное', name: 'Иван' },
    );

    expect(diff).toEqual({
      before: { iin_enc: MASKED_VALUE },
      after: { iin_enc: MASKED_VALUE },
    });
  });

  it('маскирует и в снимке состояния', () => {
    expect(snapshotForAudit({ phone: '+77011234567', passwordHash: '$argon2id$...' })).toEqual({
      phone: '+77011234567',
      passwordHash: MASKED_VALUE,
    });
  });

  it('одинаковые секреты изменением не считаются', () => {
    expect(diffForAudit({ passwordHash: 'одинаковый' }, { passwordHash: 'одинаковый' })).toBeNull();
  });

  it('в результате нет ни одного исходного секретного значения', () => {
    const diff = diffForAudit(
      { passwordHash: 'СТАРЫЙ-ХЕШ', iin_enc: 'СТАРЫЙ-ИИН' },
      { passwordHash: 'НОВЫЙ-ХЕШ', iin_enc: 'НОВЫЙ-ИИН' },
    );

    const serialized = JSON.stringify(diff);
    for (const secret of ['СТАРЫЙ-ХЕШ', 'НОВЫЙ-ХЕШ', 'СТАРЫЙ-ИИН', 'НОВЫЙ-ИИН']) {
      expect(serialized, secret).not.toContain(secret);
    }
  });
});
