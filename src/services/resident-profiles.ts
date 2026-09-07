import { getDb, type Executor } from '@/db/client';
import { ensureProfile, requireProfile, updateProfile } from '@/db/repositories/resident-profiles';
import { decryptField, encryptField, getFieldKey, last4 } from '@/lib/crypto';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { now } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { ResidentProfile } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Профиль жильца (docs/04-MODULES/01-onboarding.md).
 *
 * ИИН и номер УДЛ наружу не отдаются: в профиле для показа остаются только
 * последние четыре знака. Полное значение выдаёт отдельное действие,
 * и каждое такое раскрытие пишется в журнал (§11).
 */
export type SensitiveField = 'iin' | 'idDocNumber';

const SENSITIVE_COLUMNS = {
  iin: { enc: 'iinEnc', last4: 'iinLast4' },
  idDocNumber: { enc: 'idDocNumberEnc', last4: 'idDocLast4' },
} as const;

export interface ProfileInput {
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  sex?: 'male' | 'female' | null;
  birthDate?: string | null;
  phone?: string | null;
  university?: string | null;
  course?: number | null;
  major?: string | null;
  emergencyName?: string | null;
  emergencyPhone?: string | null;
  emergencyRelation?: string | null;
  /** Орган выдачи удостоверения. По умолчанию «МВД РК» (T8.1). */
  idDocIssuer?: string | null;
  /** Адрес прописки — реквизит нанимателя в договоре. */
  registrationAddress?: string | null;
  preferredPayment?: 'kaspi' | 'cash' | null;
  noEpilepsy?: boolean | null;
  noAsthma?: boolean | null;
  /** Задаётся один раз; дальше показано замаскированным. */
  iin?: string;
  idDocNumber?: string;
}

/**
 * Профиль для показа: зашифрованные значения заменены на последние
 * четыре знака. Полных значений здесь нет и быть не должно.
 */
export interface ProfileView extends Omit<ResidentProfile, 'iinEnc' | 'idDocNumberEnc'> {
  iinMasked: string | null;
  idDocNumberMasked: string | null;
}

function mask(last: string | null): string | null {
  return last === null || last === '' ? null : `•••• ${last}`;
}

function toView(profile: ResidentProfile): ProfileView {
  const { iinEnc: _iin, idDocNumberEnc: _doc, ...rest } = profile;

  return {
    ...rest,
    iinMasked: mask(profile.iinLast4),
    idDocNumberMasked: mask(profile.idDocLast4),
  };
}

export async function readProfile(
  actor: UserActor,
  userId: string,
  executor: Executor = getDb(),
): Promise<ProfileView> {
  assertCan(actor.context, 'user.read', { userId, houseId: actor.context.houseId });

  await ensureProfile(userId, executor);

  return toView(await requireProfile(actor.context, userId, executor));
}

function assertDigits(value: string, field: string, length: number): void {
  if (!new RegExp(`^\\d{${String(length)}}$`).test(value)) {
    throw new ValidationError(`${field}: ожидается ${String(length)} цифр`);
  }
}

export async function saveProfile(
  actor: UserActor,
  userId: string,
  input: ProfileInput,
  executor: Executor = getDb(),
): Promise<ProfileView> {
  assertCan(actor.context, 'user.updateProfile', { userId, houseId: actor.context.houseId });

  await ensureProfile(userId, executor);
  const before = await requireProfile(actor.context, userId, executor);

  const { iin, idDocNumber, ...plain } = input;
  const patch: Record<string, unknown> = { ...plain };

  if (iin !== undefined && iin !== '') {
    assertDigits(iin, 'ИИН', 12);
    const key = await getFieldKey();
    patch.iinEnc = await encryptField(iin, key);
    patch.iinLast4 = last4(iin);
  }

  if (idDocNumber !== undefined && idDocNumber !== '') {
    const key = await getFieldKey();
    patch.idDocNumberEnc = await encryptField(idDocNumber, key);
    patch.idDocLast4 = last4(idDocNumber);
  }

  if (input.noEpilepsy === true || input.noAsthma === true) {
    patch.healthDeclaredAt = now();
  }

  return executor.transaction(async (tx) => {
    const updated = await updateProfile(actor.context, userId, patch, tx);
    if (updated === null) {
      throw new NotFoundError('Профиль не найден');
    }

    /*
     * В журнал уходит разница по открытым полям; зашифрованные значения
     * маскируются автоматически по имени колонки (суффикс `Enc`).
     */
    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.userUpdated,
        entityType: 'resident_profile',
        entityId: userId,
        before: { ...before },
        after: { ...updated },
      },
      tx,
    );

    return toView(updated);
  });
}

/**
 * Раскрытие полного значения ИИН или номера УДЛ.
 * Каждое раскрытие — отдельное событие журнала без самого значения (§11):
 * иначе журнал стал бы вторым хранилищем персональных данных.
 */
export async function revealSensitiveField(
  actor: UserActor,
  userId: string,
  field: SensitiveField,
  executor: Executor = getDb(),
): Promise<string> {
  assertCan(actor.context, 'resident.revealSensitive', {
    userId,
    houseId: actor.context.houseId,
  });

  const profile = await requireProfile(actor.context, userId, executor);
  const columns = SENSITIVE_COLUMNS[field];
  const encrypted = profile[columns.enc];

  if (encrypted === null || encrypted === undefined) {
    throw new NotFoundError('Значение не задано');
  }

  const value = await decryptField(encrypted, await getFieldKey());

  await recordAudit(
    { context: actor.context, ip: actor.ip, requestId: actor.requestId },
    {
      action: AUDIT_ACTIONS.sensitiveFieldRevealed,
      entityType: 'resident_profile',
      entityId: userId,
      // Значение в журнал не попадает — только факт и какое поле.
      after: { field },
    },
    executor,
  );

  return value;
}
