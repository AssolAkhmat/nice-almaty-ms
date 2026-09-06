import { describe, expect, it } from 'vitest';

import { decryptField, encryptField, importFieldKey, last4 } from './field';

/**
 * ИИН и номер УДЛ хранятся зашифрованными (docs/01-ARCHITECTURE.md,
 * «Безопасность данных»): AES-256-GCM на ключе FIELD_ENCRYPTION_KEY.
 * Рядом лежит `*_last4` — только для поиска и показа.
 */
const KEY_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY_BASE64 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=';

const IIN = '910101300123';

describe('ключ шифрования', () => {
  it('принимает ровно 32 байта в base64', async () => {
    await expect(importFieldKey(KEY_BASE64)).resolves.toBeDefined();
  });

  it('отвергает ключ неверной длины и мусор', async () => {
    await expect(importFieldKey('QUJD')).rejects.toThrow(/32 байт/i);
    await expect(importFieldKey('не base64!!')).rejects.toThrow(/32 байт/i);
    await expect(importFieldKey('')).rejects.toThrow(/32 байт/i);
  });
});

describe('шифрование поля', () => {
  it('расшифровывается обратно', async () => {
    const key = await importFieldKey(KEY_BASE64);

    expect(await decryptField(await encryptField(IIN, key), key)).toBe(IIN);
  });

  it('переживает кириллицу и пробелы', async () => {
    const key = await importFieldKey(KEY_BASE64);
    const value = 'N 012345678 выдан 01.01.2020';

    expect(await decryptField(await encryptField(value, key), key)).toBe(value);
  });

  it('один и тот же текст даёт разный шифротекст', async () => {
    const key = await importFieldKey(KEY_BASE64);

    const first = await encryptField(IIN, key);
    const second = await encryptField(IIN, key);

    // Случайный вектор инициализации: иначе одинаковые ИИН были бы видны
    // как одинаковые байты, и шифрование не скрывало бы совпадения.
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });

  it('шифротекст не содержит открытого значения', async () => {
    const key = await importFieldKey(KEY_BASE64);
    const encrypted = await encryptField(IIN, key);

    expect(Buffer.from(encrypted).toString('utf8')).not.toContain(IIN);
    expect(Buffer.from(encrypted).toString('hex')).not.toContain(
      Buffer.from(IIN, 'utf8').toString('hex'),
    );
  });
});

/**
 * Главное свойство GCM: испорченный шифротекст обязан отказаться
 * расшифровываться, а не вернуть мусор, который уйдёт дальше по коду.
 */
describe('порча шифротекста', () => {
  it('изменение любого байта делает расшифровку невозможной', async () => {
    const key = await importFieldKey(KEY_BASE64);
    const encrypted = await encryptField(IIN, key);

    for (const position of [0, 5, 12, encrypted.length - 1]) {
      const damaged = Uint8Array.from(encrypted);
      damaged[position] = (damaged[position] ?? 0) ^ 0xff;

      await expect(decryptField(damaged, key), `байт ${String(position)}`).rejects.toThrow(
        /расшифров/i,
      );
    }
  });

  it('обрезанный шифротекст не расшифровывается', async () => {
    const key = await importFieldKey(KEY_BASE64);
    const encrypted = await encryptField(IIN, key);

    await expect(decryptField(encrypted.slice(0, 8), key)).rejects.toThrow(/расшифров/i);
    await expect(decryptField(new Uint8Array(0), key)).rejects.toThrow(/расшифров/i);
  });

  it('чужим ключом не расшифровывается', async () => {
    const key = await importFieldKey(KEY_BASE64);
    const other = await importFieldKey(OTHER_KEY_BASE64);

    await expect(decryptField(await encryptField(IIN, key), other)).rejects.toThrow(/расшифров/i);
  });
});

describe('последние четыре знака', () => {
  it('берутся с конца', () => {
    expect(last4(IIN)).toBe('0123');
    expect(last4('N012345678')).toBe('5678');
  });

  it('короткое значение отдаётся целиком', () => {
    expect(last4('12')).toBe('12');
    expect(last4('')).toBe('');
  });

  it('не зависит от пробелов по краям', () => {
    expect(last4('  910101300123  ')).toBe('0123');
  });
});
