import { getDb, type Executor } from '@/db/client';
import { requireUser, updateUserAuthState } from '@/db/repositories/users';
import { assertCan } from '@/lib/authz';
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
