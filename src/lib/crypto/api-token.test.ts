import { describe, expect, it } from 'vitest';

import { generateApiToken, hashApiToken, TOKEN_PREFIX } from './api-token';

/**
 * Значение токена и его хеш (docs/06-API.md).
 *
 * В базе лежит только хеш, поэтому важны две вещи: значения не повторяются,
 * а по хешу нельзя восстановить значение — он от него отличается.
 */
describe('значение токена', () => {
  it('узнаётся по префиксу', () => {
    expect(generateApiToken().startsWith(TOKEN_PREFIX)).toBe(true);
  });

  it('состоит из безопасных для URL символов', () => {
    expect(generateApiToken()).toMatch(/^nak_[A-Za-z0-9_-]{43}$/);
  });

  it('не повторяется', () => {
    const values = new Set(Array.from({ length: 50 }, () => generateApiToken()));

    expect(values.size).toBe(50);
  });
});

describe('хеш токена', () => {
  it('один и тот же токен даёт один и тот же хеш', async () => {
    const value = generateApiToken();

    expect(await hashApiToken(value)).toBe(await hashApiToken(value));
  });

  it('разные токены дают разные хеши', async () => {
    expect(await hashApiToken(generateApiToken())).not.toBe(await hashApiToken(generateApiToken()));
  });

  it('хеш не равен самому значению: в базу уходит не токен', async () => {
    const value = generateApiToken();

    expect(await hashApiToken(value)).not.toBe(value);
    expect(await hashApiToken(value)).not.toContain(value.slice(TOKEN_PREFIX.length));
  });

  it('длина хеша постоянна: тридцать два байта SHA-256 в base64url', async () => {
    expect(await hashApiToken('nak_short')).toHaveLength(43);
    expect(await hashApiToken(generateApiToken())).toHaveLength(43);
  });
});
