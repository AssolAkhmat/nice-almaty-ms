/**
 * Сессия: в cookie непрозрачный токен, в базе только его хеш
 * (docs/01-ARCHITECTURE.md, «Аутентификация»).
 *
 * Токен высокоэнтропийный, поэтому хеш — SHA-256: медленный argon2 здесь
 * не нужен, перебор случайных 256 бит невозможен и без замедления.
 */
export const SESSION_COOKIE_NAME = 'nice_almaty_session';

/** Тридцать дней. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Скользящее продление ленивое: не чаще раза в сутки.
 * Иначе каждый запрос писал бы в базу, а через пулер это дорого.
 */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Непрозрачный токен для cookie. */
export function createSessionToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);

  return toBase64Url(bytes);
}

/** Хеш токена: только он попадает в базу. */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));

  return toHex(digest);
}

/** Настройки cookie: разбор в отдельной функции, чтобы не разъезжались по коду. */
export function sessionCookieOptions(expiresAt: Date, isSecure: boolean) {
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  } as const;
}
