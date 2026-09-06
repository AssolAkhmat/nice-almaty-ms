import { describe, expect, it } from 'vitest';

import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_RENEW_AFTER_MS,
  SESSION_TTL_MS,
  sessionCookieOptions,
} from './session-token';

describe('токен сессии', () => {
  it('непрозрачный, безопасный для cookie и URL', () => {
    const token = createSessionToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 байта в base64url без выравнивания — 43 символа.
    expect(token).toHaveLength(43);
  });

  it('не повторяется', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createSessionToken()));

    expect(tokens.size).toBe(200);
  });

  it('в базу идёт хеш, а не сам токен', async () => {
    const token = createSessionToken();
    const hash = await hashSessionToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
  });

  it('хеш детерминирован и различает токены', async () => {
    const token = createSessionToken();

    await expect(hashSessionToken(token)).resolves.toBe(await hashSessionToken(token));
    await expect(hashSessionToken(createSessionToken())).resolves.not.toBe(
      await hashSessionToken(token),
    );
  });
});

describe('cookie сессии', () => {
  it('имя и срок жизни', () => {
    expect(SESSION_COOKIE_NAME).toBe('nice_almaty_session');
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(SESSION_RENEW_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('httpOnly, SameSite=Lax, ограничена корнем', () => {
    const expires = new Date('2026-10-06T00:00:00Z');
    const options = sessionCookieOptions(expires, true);

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.expires).toBe(expires);
    expect(options.secure).toBe(true);
  });

  it('без TLS признак secure не выставляется — иначе cookie не поставится в dev', () => {
    expect(sessionCookieOptions(new Date('2026-10-06T00:00:00Z'), false).secure).toBe(false);
  });
});
