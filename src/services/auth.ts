import { getAuthProvider } from '@/adapters/auth';
import { getDb, type Executor } from '@/db/client';
import {
  hitRateLimit,
  purgeExpiredRateLimits,
  resetRateLimit,
} from '@/db/repositories/rate-limits';
import { tryNormalizePhone } from '@/domain/phone';
import { RateLimitedError } from '@/lib/errors';
import {
  isOverLimit,
  LOGIN_WINDOW_MS,
  loginIpKey,
  loginPhoneKey,
  retryAfterSeconds,
} from '@/lib/rate-limit';
import { now } from '@/lib/time';

import type { SignInInput, SignInResult } from '@/adapters/auth';

/**
 * Прикладной сценарий входа: ограничение частоты и аутентификация.
 * Драйвер аутентификации политикой не занимается — его дело проверить
 * пароль и завести сессию.
 */

/** Ключи считаются независимо: подбор пароля к одному номеру и перебор номеров с одного адреса. */
function limitKeys(input: SignInInput): string[] {
  const keys: string[] = [];

  const phone = tryNormalizePhone(input.phone);
  if (phone !== null) {
    keys.push(loginPhoneKey(phone));
  }

  if (input.ip !== undefined && input.ip !== '') {
    keys.push(loginIpKey(input.ip));
  }

  return keys;
}

async function enforceLimit(keys: string[], executor: Executor): Promise<void> {
  // Ленивая уборка просроченных окон на пути записи; отдельное задание — фаза 6.
  await purgeExpiredRateLimits(LOGIN_WINDOW_MS, executor);

  const moment = now();

  for (const key of keys) {
    const state = await hitRateLimit(key, LOGIN_WINDOW_MS, executor);

    if (isOverLimit(state.count)) {
      throw new RateLimitedError(
        'Слишком много попыток входа. Попробуйте позже',
        retryAfterSeconds(state.windowStart, moment),
      );
    }
  }
}

export async function signIn(
  input: SignInInput,
  executor: Executor = getDb(),
): Promise<SignInResult> {
  const keys = limitKeys(input);

  await enforceLimit(keys, executor);

  const result = await getAuthProvider().signIn(input, executor);

  // Успешный вход обнуляет счётчики: иначе честный пользователь после
  // нескольких опечаток остался бы заблокированным на четверть часа.
  for (const key of keys) {
    await resetRateLimit(key, executor);
  }

  return result;
}

export async function signOut(token: string, executor: Executor = getDb()): Promise<void> {
  await getAuthProvider().revoke(token, executor);
}

export async function getSession(token: string, executor: Executor = getDb()) {
  return getAuthProvider().getSession(token, executor);
}
