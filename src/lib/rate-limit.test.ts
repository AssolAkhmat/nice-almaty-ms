import { describe, expect, it } from 'vitest';

import {
  isOverLimit,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  loginIpKey,
  loginPhoneKey,
  retryAfterSeconds,
} from './rate-limit';

describe('ограничение попыток входа', () => {
  it('десять попыток за пятнадцать минут', () => {
    expect(LOGIN_MAX_ATTEMPTS).toBe(10);
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('десятая попытка проходит, одиннадцатая отклоняется', () => {
    expect(isOverLimit(10)).toBe(false);
    expect(isOverLimit(11)).toBe(true);
  });

  it('ключи телефона и адреса не пересекаются', () => {
    expect(loginPhoneKey('+77011234567')).toBe('login:phone:+77011234567');
    expect(loginIpKey('203.0.113.7')).toBe('login:ip:203.0.113.7');
    expect(loginPhoneKey('x')).not.toBe(loginIpKey('x'));
  });

  it('время до конца окна считается от его начала', () => {
    const windowStart = new Date('2026-09-06T12:00:00Z');

    expect(retryAfterSeconds(windowStart, new Date('2026-09-06T12:00:00Z'))).toBe(900);
    expect(retryAfterSeconds(windowStart, new Date('2026-09-06T12:10:00Z'))).toBe(300);
  });

  it('в конце окна и после него отдаётся хотя бы секунда, а не ноль и не минус', () => {
    const windowStart = new Date('2026-09-06T12:00:00Z');

    expect(retryAfterSeconds(windowStart, new Date('2026-09-06T12:15:00Z'))).toBe(1);
    expect(retryAfterSeconds(windowStart, new Date('2026-09-06T12:20:00Z'))).toBe(1);
  });
});
