import { getDb, type Executor } from '@/db/client';
import { requireHouse } from '@/db/repositories/houses';
import {
  createUser as insertUser,
  findUserByPhone,
  listUsers,
  requireUser,
  updateUser,
  updateUserAuthState,
} from '@/db/repositories/users';
import { revokeAllUserSessions } from '@/db/repositories/sessions';
import { normalizePhone } from '@/domain/phone';
import { assertCan } from '@/lib/authz';
import { ConflictError, ValidationError } from '@/lib/errors';
import { generateTemporaryPassword, hashPassword } from '@/lib/password';
import { plusMilliseconds, now } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { AccessContext } from '@/db/access';
import type { User } from '@/db/schema';
import type { AuditActor } from './audit';

/**
 * Разрешение сброса пароля (docs/01-ARCHITECTURE.md, D8).
 * Осознанно слабая схема, выбранная владельцем: пока разрешение действует,
 * вход проходит с любым паролем. Отсюда три ограничения — сутки, один раз,
 * и каждое действие в журнале.
 */
export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;

export interface UserActor {
  context: AccessContext;
  ip?: string | undefined;
  requestId?: string | undefined;
}

function auditActor(actor: UserActor): AuditActor {
  return { context: actor.context, ip: actor.ip, requestId: actor.requestId };
}

/**
 * Выдать одноразовое разрешение. Гасит его сам вход: провайдер обнуляет
 * поле при использовании, поэтому повторно оно не сработает.
 */
export async function allowPasswordReset(
  actor: UserActor,
  userId: string,
  executor: Executor = getDb(),
): Promise<User> {
  const target = await requireUser(actor.context, userId, executor);

  // Проверка прав идёт после поиска: чужой пользователь обязан быть
  // неотличим от несуществующего (P1-1), а не выдавать себя отказом.
  assertCan(actor.context, 'user.allowPasswordReset', {
    houseId: target.houseId,
    userId: target.id,
  });

  const allowedUntil = plusMilliseconds(now(), PASSWORD_RESET_TTL_MS);

  return executor.transaction(async (tx) => {
    await updateUserAuthState(target.id, { passwordResetAllowedUntil: allowedUntil }, tx);

    await recordAudit(
      auditActor(actor),
      {
        action: AUDIT_ACTIONS.passwordResetAllowed,
        entityType: 'user',
        entityId: target.id,
        before: { passwordResetAllowedUntil: target.passwordResetAllowedUntil },
        after: { passwordResetAllowedUntil: allowedUntil },
      },
      tx,
    );

    return { ...target, passwordResetAllowedUntil: allowedUntil };
  });
}

/** Список учётных записей в области видимости контекста. */
export async function listAccounts(
  actor: UserActor,
  executor: Executor = getDb(),
): Promise<User[]> {
  assertCan(actor.context, 'user.read', {
    houseId: actor.context.houseId,
    userId: actor.context.userId,
  });

  return listUsers(actor.context, executor);
}

export interface CreateAccountInput {
  phone: string;
  role: 'superadmin' | 'admin' | 'resident';
  /** Обязателен для роли `admin` и запрещён остальным (инвариант БД). */
  houseId?: string | null;
}

export interface CreatedAccount {
  user: User;
  /** Показывается один раз: в базе только argon2id-хеш. */
  temporaryPassword: string;
}

/**
 * Создание аккаунта. Самостоятельной регистрации нет, заводит только
 * суперадмин (docs/00-PRD.md). Временный пароль обязателен к смене.
 */
export async function createAccount(
  actor: UserActor,
  input: CreateAccountInput,
  executor: Executor = getDb(),
): Promise<CreatedAccount> {
  assertCan(actor.context, 'user.create');

  const phone = normalizePhone(input.phone);
  const houseId = input.role === 'admin' ? (input.houseId ?? null) : null;

  if (input.role === 'admin' && houseId === null) {
    throw new ValidationError('Админу нужен дом');
  }

  if (houseId !== null) {
    // Дом обязан быть видим создателю: иначе аккаунт уедет в чужой дом.
    await requireHouse(actor.context, houseId, executor);
  }

  if ((await findUserByPhone(phone, executor)) !== null) {
    throw new ConflictError('Учётная запись с таким телефоном уже есть');
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  return executor.transaction(async (tx) => {
    const user = await insertUser(
      actor.context,
      { phone, role: input.role, houseId, passwordHash, mustChangePassword: true },
      tx,
    );

    await recordAudit(
      auditActor(actor),
      {
        action: AUDIT_ACTIONS.userCreated,
        entityType: 'user',
        entityId: user.id,
        after: { phone, role: input.role, houseId },
      },
      tx,
    );

    return { user, temporaryPassword };
  });
}

/**
 * Архивация. Удаления нет: история обязана сохраниться (модуль 11).
 * Сессии отзываются сразу — архивированный не должен доработать смену.
 */
export async function archiveAccount(
  actor: UserActor,
  userId: string,
  executor: Executor = getDb(),
): Promise<User> {
  const target = await requireUser(actor.context, userId, executor);

  assertCan(actor.context, 'user.archive', { houseId: target.houseId, userId: target.id });

  if (target.id === actor.context.userId) {
    throw new ValidationError('Нельзя архивировать собственную учётную запись');
  }

  return executor.transaction(async (tx) => {
    const updated = await updateUser(actor.context, target.id, { status: 'archived' }, tx);
    await revokeAllUserSessions(target.id, tx);

    await recordAudit(
      auditActor(actor),
      {
        action: AUDIT_ACTIONS.userArchived,
        entityType: 'user',
        entityId: target.id,
        before: { status: target.status },
        after: { status: 'archived' },
      },
      tx,
    );

    return updated ?? target;
  });
}

/**
 * Смена роли отдельным действием (долг фазы 1, модуль 1).
 *
 * Роль и дом связаны инвариантом базы «один админ — один дом»: админу дом
 * обязателен, жильцу и суперадмину — запрещён. Поэтому дом меняется здесь же,
 * а не отдельным шагом: между двумя шагами запись была бы недопустимой.
 */
export async function changeAccountRole(
  actor: UserActor,
  userId: string,
  role: User['role'],
  houseId: string | null,
  executor: Executor = getDb(),
): Promise<User> {
  const target = await requireUser(actor.context, userId, executor);

  assertCan(actor.context, 'user.changeRole', { houseId: target.houseId, userId: target.id });

  if (target.id === actor.context.userId) {
    throw new ValidationError('Нельзя менять роль собственной учётной записи');
  }

  if (role === 'admin' && houseId === null) {
    throw new ValidationError('Админу нужен дом');
  }

  const nextHouseId = role === 'admin' ? houseId : null;

  if (nextHouseId !== null) {
    await requireHouse(actor.context, nextHouseId, executor);
  }

  if (target.role === role && target.houseId === nextHouseId) {
    return target;
  }

  return executor.transaction(async (tx) => {
    const updated = await updateUser(actor.context, target.id, { role, houseId: nextHouseId }, tx);

    /*
     * Роль лежит в контексте доступа, а контекст берётся из сессии:
     * старые сессии продолжили бы работать с прежними правами.
     */
    await revokeAllUserSessions(target.id, tx);

    await recordAudit(
      auditActor(actor),
      {
        action: AUDIT_ACTIONS.userRoleChanged,
        entityType: 'user',
        entityId: target.id,
        before: { role: target.role, houseId: target.houseId },
        after: { role, houseId: nextHouseId },
      },
      tx,
    );

    return updated ?? target;
  });
}

/**
 * Перевод админа на другой дом. Роль и дом связаны инвариантом БД,
 * поэтому смена дома возможна только для админа.
 */
export async function moveAdminToHouse(
  actor: UserActor,
  userId: string,
  houseId: string,
  executor: Executor = getDb(),
): Promise<User> {
  const target = await requireUser(actor.context, userId, executor);

  assertCan(actor.context, 'user.moveAdmin', { houseId: target.houseId, userId: target.id });

  if (target.role !== 'admin') {
    throw new ValidationError('Дом в учётной записи есть только у админа');
  }

  await requireHouse(actor.context, houseId, executor);

  return executor.transaction(async (tx) => {
    const updated = await updateUser(actor.context, target.id, { houseId }, tx);

    await recordAudit(
      auditActor(actor),
      {
        action: AUDIT_ACTIONS.userHouseChanged,
        entityType: 'user',
        entityId: target.id,
        before: { houseId: target.houseId },
        after: { houseId },
      },
      tx,
    );

    return updated ?? target;
  });
}
