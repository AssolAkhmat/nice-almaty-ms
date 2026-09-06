import { normalizePhone } from '@/domain/phone';
import { getDb, type Executor } from '@/db/client';
import {
  createSession,
  extendSession,
  findLiveSession,
  revokeAllUserSessions,
  revokeSession,
} from '@/db/repositories/sessions';
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

export function toAccessContext(user: User): AccessContext {
  return {
    orgId: user.orgId,
    userId: user.id,
    role: user.role,
    houseId: user.houseId,
  };
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

  return { user: row.user, session: row.session, context: toAccessContext(row.user) };
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
