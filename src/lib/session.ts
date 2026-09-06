import { cookies } from 'next/headers';

import { getSession } from '@/services/auth';

import { loadEnv } from './env/load';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from './session-token';

import type { AuthSession } from '@/adapters/auth';

/**
 * Работа с cookie сессии на сервере.
 * Единственное место, где приложение достаёт токен из запроса.
 */

/** Признак secure берётся из адреса приложения: в dev по http cookie иначе не поставится. */
function isSecureContext(): boolean {
  return loadEnv().APP_URL.startsWith('https://');
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();

  return store.get(SESSION_COOKIE_NAME)?.value ?? null;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();

  store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(expiresAt, isSecureContext()));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();

  store.delete(SESSION_COOKIE_NAME);
}

/** Действующая сессия или null. Проверка идёт в базу: cookie сама по себе ничего не значит. */
export async function getCurrentSession(): Promise<AuthSession | null> {
  const token = await readSessionToken();
  if (token === null) {
    return null;
  }

  return getSession(token);
}
