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
import { createResidency, listResidencies } from '@/db/repositories/residencies';

import { nextNumberForOrg } from './contract-numbers';
import { revokeAllUserSessions } from '@/db/repositories/sessions';
import { normalizePhone } from '@/domain/phone';
import { assertCan } from '@/lib/authz';
import { ConflictError, ValidationError } from '@/lib/errors';
import { generateTemporaryPassword, hashPassword, verifyPassword } from '@/lib/password';
import { plusMilliseconds, now } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { AccessContext } from '@/db/access';
import type { Residency, User } from '@/db/schema';
import type { AuditActor } from './audit';

/**
 * Разрешение сброса пароля (docs/01-ARCHITECTURE.md, D8).
 * Осознанно слабая схема, выбранная владельцем: пока разрешение действует,
 * вход проходит с любым паролем. Отсюда три ограничения — сутки, один раз,
 * и каждое действие в журнале.
 */
export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;

export interface UserActor {
  /**
   * Скоупы токена, если запрос пришёл от бота. У входа по сессии их нет:
   * человек ограничен ролью, а не выданным набором (docs/06-API.md).
   */
  scopes?: readonly string[] | undefined;
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

/**
 * Список учётных записей в области видимости контекста, новые сверху.
 *
 * Порядок здесь не украшение: список пагинируется по 25 записей (инцидент I3),
 * и при сортировке по телефону только что заведённый аккаунт оказывался
 * на случайной странице — вместе с кнопками «разрешить сброс» и «архивировать».
 */
export async function listAccounts(
  actor: UserActor,
  executor: Executor = getDb(),
): Promise<User[]> {
  assertCan(actor.context, 'user.read', {
    houseId: actor.context.houseId,
    userId: actor.context.userId,
  });

  return listUsers(actor.context, executor, { order: 'newest' });
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

  /*
   * Дом админа лежит в учётной записи, дом жильца — в проживании (D11).
   * Админ — тоже жилец своего дома: место, договор и ротации у него те же
   * (§6 «включая админа»), поэтому проживание заводится обоим, а не только
   * жильцу (P9-3). У суперадмина дома нет — и проживания тоже.
   */
  const houseId = input.role === 'admin' ? (input.houseId ?? null) : null;
  const residencyHouseId = input.role === 'superadmin' ? null : (input.houseId ?? null);

  if (input.role === 'admin' && houseId === null) {
    throw new ValidationError('Админу нужен дом');
  }

  if (input.role === 'resident' && residencyHouseId === null) {
    throw new ValidationError('Жильцу нужен дом');
  }

  for (const id of [houseId, residencyHouseId]) {
    if (id !== null) {
      // Дом обязан быть видим создателю: иначе аккаунт уедет в чужой дом.
      await requireHouse(actor.context, id, executor);
    }
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
        after: { phone, role: input.role, houseId: houseId ?? residencyHouseId },
      },
      tx,
    );

    /*
     * Проживание заводится сразу, шагом 1 из §1.2: мастер заселения, профиль
     * и документы прикрепляются к нему, а до сих пор его нельзя было создать
     * ничем, кроме прямой записи в базу (P2-42).
     */
    if (residencyHouseId !== null) {
      await openResidency(actor, user.id, residencyHouseId, tx);
    }

    return { user, temporaryPassword };
  });
}

/**
 * Проживание для учётной записи в доме. Номер договора присваивается сразу:
 * договор собирают позже, но ссылаться на проживание по номеру начинают
 * с первого дня (T8.1). Заведение попадает в журнал.
 */
async function openResidency(
  actor: UserActor,
  userId: string,
  houseId: string,
  tx: Executor,
): Promise<Residency> {
  const contractNumber = await nextNumberForOrg(actor.context.orgId, tx);
  const residency = await createResidency(
    actor.context,
    { userId, houseId, status: 'created', contractNumber },
    tx,
  );

  await recordAudit(
    auditActor(actor),
    {
      action: AUDIT_ACTIONS.residencyCreated,
      entityType: 'residency',
      entityId: residency.id,
      after: { userId, houseId, status: 'created', contractNumber },
    },
    tx,
  );

  return residency;
}

/**
 * Проживание для учётной записи, заведённой до P9-3: у админов, созданных
 * раньше 9 сентября 2026, проживания нет, и назначить им место нечем.
 * Повторный вызов ничего не заводит — возвращает то, что есть.
 */
export async function openResidencyForAccount(
  actor: UserActor,
  userId: string,
  executor: Executor = getDb(),
): Promise<Residency> {
  // То же право, что заводит проживание вместе с учётной записью.
  assertCan(actor.context, 'user.create');

  const target = await requireUser(actor.context, userId, executor);

  if (target.role === 'superadmin') {
    throw new ValidationError('Суперадмин не заселяется: у него нет дома');
  }

  const [existing] = await listResidencies(actor.context, { userId: target.id }, executor);
  if (existing !== undefined) {
    return existing;
  }

  if (target.houseId === null) {
    throw new ValidationError('У учётной записи нет дома: заселять некуда');
  }

  const houseId = target.houseId;

  return executor.transaction((tx) => openResidency(actor, target.id, houseId, tx));
}

export interface ChangePhoneInput {
  phone: string;
  /** Обязателен, когда человек меняет собственный номер: это его логин. */
  currentPassword?: string | undefined;
}

/**
 * Смена номера телефона (T9.7). Номер — логин, поэтому свой меняется только
 * с действующим паролем; чужой меняет админ своего дома или суперадмин —
 * тот же круг, что выдаёт разрешение сброса пароля. Каждая смена в журнале:
 * до 9 сентября 2026 экрана не было, и номер суперадмина правили в базе
 * мимо `audit_log`. Сессии остаются: сменился логин, а не его владелец.
 */
export async function changeAccountPhone(
  actor: UserActor,
  userId: string,
  input: ChangePhoneInput,
  executor: Executor = getDb(),
): Promise<User> {
  const target = await requireUser(actor.context, userId, executor);

  /*
   * Дом жильца лежит в проживании, а не в учётной записи (D11): для проверки
   * «свой дом» он берётся оттуда. Видимость проживаний уже отфильтрована
   * по контексту, чужой дом сюда не попадёт.
   */
  const [residency] = await listResidencies(actor.context, { userId: target.id }, executor);
  const houseId = target.houseId ?? residency?.houseId ?? null;

  assertCan(actor.context, 'user.changePhone', { houseId, userId: target.id });

  if (target.id === actor.context.userId) {
    const password = input.currentPassword ?? '';

    if (password === '' || !(await verifyPassword(target.passwordHash, password))) {
      throw new ValidationError('Неверный текущий пароль', { field: 'currentPassword' });
    }
  }

  const phone = normalizePhone(input.phone);

  if (phone === target.phone) {
    return target;
  }

  const taken = await findUserByPhone(phone, executor);
  if (taken !== null && taken.id !== target.id) {
    throw new ConflictError('Учётная запись с таким телефоном уже есть');
  }

  return executor.transaction(async (tx) => {
    const updated = await updateUser(actor.context, target.id, { phone }, tx);

    await recordAudit(
      auditActor(actor),
      {
        action: AUDIT_ACTIONS.userPhoneChanged,
        entityType: 'user',
        entityId: target.id,
        before: { phone: target.phone },
        after: { phone },
      },
      tx,
    );

    return updated ?? { ...target, phone };
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

    /*
     * Админ и жилец живут в доме, и проживание у них обязано быть (P9-3).
     * Есть — остаётся как есть, даже если админа назначили на другой дом:
     * переезд человека — отдельное решение, а не следствие смены роли.
     * Нет — заводится в доме роли: у нового админа это его дом, у бывшего
     * админа, ставшего жильцом, — дом, которым он управлял.
     */
    const residencyHouseId = role === 'admin' ? nextHouseId : target.houseId;

    if (role !== 'superadmin' && residencyHouseId !== null) {
      const [existing] = await listResidencies(actor.context, { userId: target.id }, tx);

      if (existing === undefined) {
        await openResidency(actor, target.id, residencyHouseId, tx);
      }
    }

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
