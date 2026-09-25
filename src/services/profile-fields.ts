import { getDb, type Executor } from '@/db/client';
import {
  clearFieldValue,
  createFieldDef,
  findFieldDef,
  listFieldDefs,
  listFieldValues,
  setFieldValue,
  updateFieldDef,
} from '@/db/repositories/profile-fields';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { LOCALES } from '@/lib/i18n/config';
import { now } from '@/lib/time';
import {
  missingRequiredFields,
  validateDeclaredValues,
  type FieldDeclaration,
} from '@/domain/profile-fields';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { ProfileFieldDef, ProfileFieldType } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Дополнительные поля профиля (указание владельца от 21 сентября 2026, D31).
 *
 * Объявляет суперадмин — это правило всей сети, как срок годности документа,
 * поэтому право то же: `settings.org.write`. Значения правит тот, кому открыт
 * профиль жильца, тем же правом `user.updateProfile`: дополнительное поле —
 * часть профиля, а не отдельная сущность с отдельным доступом.
 *
 * Разбор значений — в `src/domain/profile-fields.ts`, чистым ядром. Здесь
 * только доступ, запись и журнал.
 */
export interface FieldDeclarationInput {
  code: string;
  nameI18n: Record<string, string>;
  type: ProfileFieldType;
  isRequired: boolean;
  options: string[];
  sortOrder: number;
}

/** Объявление вместе со значением одного человека. */
export interface DeclaredFieldView {
  code: string;
  id: string;
  isArchived: boolean;
  isRequired: boolean;
  nameI18n: Record<string, string>;
  options: string[];
  sortOrder: number;
  type: ProfileFieldType;
  value: string | null;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,38}$/;

const MAX_OPTIONS = 40;

function assertCode(code: string): void {
  if (!CODE_PATTERN.test(code)) {
    throw new ValidationError('profileFieldCodeInvalid', { code });
  }
}

function assertNames(nameI18n: Record<string, string>): void {
  const missing = LOCALES.filter((locale) => (nameI18n[locale] ?? '').trim() === '');

  if (missing.length > 0) {
    throw new ValidationError('profileFieldNameRequired', { locales: missing });
  }
}

function assertOptions(type: ProfileFieldType, options: readonly string[]): void {
  if (type !== 'choice') {
    if (options.length > 0) {
      throw new ValidationError('profileFieldOptionsUnexpected', { type });
    }

    return;
  }

  const cleaned = options.filter((option) => option.trim() !== '');

  if (cleaned.length === 0 || cleaned.length > MAX_OPTIONS) {
    throw new ValidationError('profileFieldOptionsRequired', { count: cleaned.length });
  }

  if (new Set(cleaned).size !== cleaned.length) {
    throw new ValidationError('profileFieldOptionsDuplicate', {});
  }
}

function toDeclaration(def: ProfileFieldDef): FieldDeclaration {
  return {
    code: def.code,
    isArchived: def.archivedAt !== null,
    isRequired: def.isRequired,
    options: def.options as string[],
    type: def.type,
  };
}

/** Объявления сети: действующие, а с `includeArchived` — вместе с архивом. */
export async function listDeclarations(
  actor: UserActor,
  options: { includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<ProfileFieldDef[]> {
  assertCan(actor.context, 'settings.org.read');

  return listFieldDefs(actor.context, options, executor);
}

/** То же для внутренних нужд: договор и форма профиля, без проверки настроек. */
export async function declarationsFor(
  actor: UserActor,
  options: { includeArchived?: boolean } = {},
  executor: Executor = getDb(),
): Promise<ProfileFieldDef[]> {
  return listFieldDefs(actor.context, options, executor);
}

export async function declareField(
  actor: UserActor,
  input: FieldDeclarationInput,
  executor: Executor = getDb(),
): Promise<ProfileFieldDef> {
  assertCan(actor.context, 'settings.org.write');

  const code = input.code.trim();
  assertCode(code);
  assertNames(input.nameI18n);
  assertOptions(input.type, input.options);

  const existing = await listFieldDefs(actor.context, { includeArchived: true }, executor);

  if (existing.some((def) => def.code === code)) {
    /*
     * Код архивированного поля тоже занят: токен `profile.<код>` обязан
     * значить в старом договоре то же, что и в новом.
     */
    throw new ValidationError('profileFieldCodeTaken', { code });
  }

  return executor.transaction(async (tx) => {
    const created = await createFieldDef(
      actor.context,
      {
        code,
        nameI18n: input.nameI18n,
        type: input.type,
        isRequired: input.isRequired,
        options: input.type === 'choice' ? input.options.filter((one) => one.trim() !== '') : [],
        sortOrder: input.sortOrder,
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.profileFieldDeclared,
        entityType: 'profile_field_def',
        entityId: created.id,
        after: { ...created },
      },
      tx,
    );

    return created;
  });
}

/**
 * Правка объявления. Код и тип не меняются: по коду собран договор,
 * а сменой типа прежние значения перестали бы разбираться.
 */
export async function updateDeclaration(
  actor: UserActor,
  fieldId: string,
  patch: {
    isRequired?: boolean;
    nameI18n?: Record<string, string>;
    options?: string[];
    sortOrder?: number;
  },
  executor: Executor = getDb(),
): Promise<ProfileFieldDef> {
  assertCan(actor.context, 'settings.org.write');

  const before = await findFieldDef(actor.context, fieldId, executor);

  if (before === null) {
    throw new NotFoundError('Поле профиля не найдено');
  }

  if (patch.nameI18n !== undefined) {
    assertNames(patch.nameI18n);
  }

  if (patch.options !== undefined) {
    assertOptions(before.type, patch.options);
  }

  return executor.transaction(async (tx) => {
    const updated = await updateFieldDef(actor.context, fieldId, patch, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.profileFieldUpdated,
        entityType: 'profile_field_def',
        entityId: fieldId,
        before: { ...before },
        after: { ...updated },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Архивация вместо удаления: значения остаются в подписанных договорах
 * и в карточке. Обратное действие — снятие архива — тоже здесь: ошибочно
 * архивированное поле возвращают, а не заводят заново под другим кодом.
 */
export async function archiveDeclaration(
  actor: UserActor,
  fieldId: string,
  archived: boolean,
  executor: Executor = getDb(),
): Promise<ProfileFieldDef> {
  assertCan(actor.context, 'settings.org.write');

  const before = await findFieldDef(actor.context, fieldId, executor);

  if (before === null) {
    throw new NotFoundError('Поле профиля не найдено');
  }

  return executor.transaction(async (tx) => {
    const updated = await updateFieldDef(
      actor.context,
      fieldId,
      { archivedAt: archived ? now() : null },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.profileFieldArchived,
        entityType: 'profile_field_def',
        entityId: fieldId,
        before: { archivedAt: before.archivedAt },
        after: { archivedAt: updated.archivedAt },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Поля жильца с его значениями. Архивированное поле показывается, только
 * если у человека есть по нему значение: пустая строка архива никому
 * ничего не говорит.
 */
export async function readDeclaredFields(
  actor: UserActor,
  userId: string,
  executor: Executor = getDb(),
): Promise<DeclaredFieldView[]> {
  assertCan(actor.context, 'user.read', { userId, houseId: actor.context.houseId });

  const defs = await listFieldDefs(actor.context, { includeArchived: true }, executor);
  const values = await listFieldValues(actor.context, userId, executor);
  const byField = new Map(values.map((row) => [row.fieldId, row.value]));

  return defs
    .filter((def) => def.archivedAt === null || byField.has(def.id))
    .map((def) => {
      const value = byField.get(def.id) ?? null;

      return {
        code: def.code,
        id: def.id,
        isArchived: def.archivedAt !== null,
        isRequired: def.isRequired,
        nameI18n: def.nameI18n as Record<string, string>,
        options: def.options as string[],
        sortOrder: def.sortOrder,
        type: def.type,
        value,
      };
    });
}

/**
 * Запись значений. Обязательность проверяется здесь, а не только в браузере:
 * форма — не единственная дорога, есть ещё `/api/v1` и бот.
 *
 * Каждое изменённое поле пишет свою запись в журнал: правка значения обязана
 * читаться построчно, иначе «кто поменял кафедру» осталось бы без ответа.
 */
export async function saveDeclaredFields(
  actor: UserActor,
  userId: string,
  raw: Readonly<Record<string, string>>,
  executor: Executor = getDb(),
): Promise<DeclaredFieldView[]> {
  assertCan(actor.context, 'user.updateProfile', { userId, houseId: actor.context.houseId });

  const defs = await listFieldDefs(actor.context, { includeArchived: true }, executor);
  const values = validateDeclaredValues(defs.map(toDeclaration), raw);
  const byCode = new Map(defs.map((def) => [def.code, def]));
  const existing = await listFieldValues(actor.context, userId, executor);
  const before = new Map(existing.map((row) => [row.fieldId, row.value]));

  await executor.transaction(async (tx) => {
    for (const [code, value] of Object.entries(values)) {
      const def = byCode.get(code);

      if (def === undefined) {
        continue;
      }

      const previous = before.get(def.id) ?? null;

      if (previous === value) {
        continue;
      }

      if (value === null) {
        await clearFieldValue(actor.context, { userId, fieldId: def.id }, tx);
      } else {
        await setFieldValue(actor.context, { userId, fieldId: def.id, value }, tx);
      }

      await recordAudit(
        { context: actor.context, ip: actor.ip, requestId: actor.requestId },
        {
          action: AUDIT_ACTIONS.profileFieldValueChanged,
          entityType: 'profile_field_value',
          entityId: userId,
          before: { code, value: previous },
          after: { code, value },
        },
        tx,
      );
    }
  });

  return readDeclaredFields(actor, userId, executor);
}

/**
 * Проверка перед шагом, который требует полного профиля: заселение
 * не завершается, пока обязательные объявленные поля пусты.
 */
export async function assertDeclaredFieldsFilled(
  actor: UserActor,
  userId: string,
  executor: Executor = getDb(),
): Promise<void> {
  const fields = await readDeclaredFields(actor, userId, executor);
  const missing = missingRequiredFields(
    fields.map((field) => ({
      code: field.code,
      isArchived: field.isArchived,
      isRequired: field.isRequired,
      options: field.options,
      type: field.type,
    })),
    Object.fromEntries(fields.map((field) => [field.code, field.value])),
  );

  if (missing.length > 0) {
    throw new ValidationError('profileFieldsRequired', { codes: missing.join(', ') });
  }
}
