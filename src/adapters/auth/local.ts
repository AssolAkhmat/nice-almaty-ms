import { normalizePhone } from '@/domain/phone';
import { getDb, type Executor } from '@/db/client';
import {
  createSession,
  extendSession,
  findLiveSession,
  revokeAllUserSessions,
  revokeSession,
} from '@/db/repositories/sessions';
import { loadOverridesFor } from '@/db/repositories/permission-overrides';
import { findUserByPhone, updateUserAuthState } from '@/db/repositories/users';
import { UnauthorizedError } from '@/lib/errors';
import { hashPassword, verifyPassword } from '@/lib/password';
import {
  createSessionToken,
  hashSessionToken,
  SESSION_RENEW_AFTER_MS,
  SESSION_TTL_MS,
} from '@/lib/session-token';
import { minusMilliseconds, now, plusMilliseconds } from '@/lib/time';

import type { AccessContext } from '@/db/access';
import type { User } from '@/db/schema';
import type { AuthProvider, AuthSession, SignInInput, SignInResult } from './types';

/**
 * Драйвер `local`: сессии в базе, пароли argon2id.
 *
 * Разрешение сброса пароля — осознанно слабая схема, выбранная владельцем (D8):
 * пока разрешение действует, вход проходит с любым паролем. Разрешение
 * одноразовое и живёт сутки; каждое использование пишется в аудит (T1.7).
 */

/** Ответ на неверные данные один и тот же: существование аккаунта не раскрывается. */
function invalidCredentials(): never {
  throw new UnauthorizedError('Неверный телефон или пароль');
}

export function toAccessContext(
  user: User,
  overrides: Readonly<Partial<Record<string, boolean>>> = {},
): AccessContext {
  return {
    orgId: user.orgId,
    userId: user.id,
    role: user.role,
    houseId: user.houseId,
    overrides,
  };
}

/**
 * Контекст вместе с переопределениями полномочий (указание владельца,
 * 23 сентября 2026). Они читаются тем же запросом, что и сессия, и живут
 * ровно столько же: снятое право обязано действовать сразу, а не после
 * перелогина, поэтому кешировать их дольше запроса нельзя.
 *
 * Суперадмина и жильца это не касается, и лишнего запроса им не делается.
 */
async function contextFor(user: User, executor: Executor): Promise<AccessContext> {
  if (user.role !== 'admin') {
    return toAccessContext(user);
  }

  return toAccessContext(user, await loadOverridesFor(user.orgId, user.id, executor));
}

function isResetPermissionActive(user: User, moment: Date): boolean {
  return user.passwordResetAllowedUntil !== null && user.passwordResetAllowedUntil > moment;
}

async function signIn(input: SignInInput, executor: Executor = getDb()): Promise<SignInResult> {
  const phone = (() => {
    try {
      return normalizePhone(input.phone);
    } catch {
      return invalidCredentials();
    }
  })();

  const user = await findUserByPhone(phone, executor);
  if (user === null || user.status === 'archived') {
    invalidCredentials();
  }

  const moment = now();
  const usedResetPermission = isResetPermissionActive(user, moment);

  if (!usedResetPermission && !(await verifyPassword(user.passwordHash, input.password))) {
    invalidCredentials();
  }

  const token = createSessionToken();
  const expiresAt = plusMilliseconds(moment, SESSION_TTL_MS);

  await createSession(
    {
      userId: user.id,
      tokenHash: await hashSessionToken(token),
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
    executor,
  );

  await updateUserAuthState(
    user.id,
    {
      lastLoginAt: moment,
      // Разрешение одноразовое: гасим сразу и требуем немедленной смены пароля.
      ...(usedResetPermission ? { passwordResetAllowedUntil: null, mustChangePassword: true } : {}),
    },
    executor,
  );

  return {
    token,
    expiresAt,
    user,
    mustChangePassword: usedResetPermission || user.mustChangePassword,
    usedResetPermission,
  };
}

async function getSession(
  token: string,
  executor: Executor = getDb(),
): Promise<AuthSession | null> {
  const row = await findLiveSession(await hashSessionToken(token), executor);
  if (row === null) {
    return null;
  }

  if (row.user.status === 'archived') {
    return null;
  }

  const moment = now();
  const lastExtendedAt = minusMilliseconds(row.session.expiresAt, SESSION_TTL_MS);

  // Продление не чаще раза в сутки: иначе запись в базу на каждый запрос.
  if (moment.getTime() - lastExtendedAt.getTime() >= SESSION_RENEW_AFTER_MS) {
    const expiresAt = plusMilliseconds(moment, SESSION_TTL_MS);
    await extendSession(row.session.id, expiresAt, executor);
    row.session.expiresAt = expiresAt;
  }

  return {
    user: row.user,
    session: row.session,
    context: await contextFor(row.user, executor),
  };
}

async function revoke(token: string, executor: Executor = getDb()): Promise<void> {
  await revokeSession(await hashSessionToken(token), executor);
}

/**
 * Смена пароля отзывает все сессии пользователя: иначе украденная сессия
 * пережила бы смену пароля, ради которой её и меняют.
 */
async function setPassword(
  userId: string,
  newPassword: string,
  executor: Executor = getDb(),
): Promise<void> {
  await updateUserAuthState(
    userId,
    {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      passwordResetAllowedUntil: null,
    },
    executor,
  );

  await revokeAllUserSessions(userId, executor);
}

export const localAuthProvider: AuthProvider = { signIn, getSession, revoke, setPassword };
