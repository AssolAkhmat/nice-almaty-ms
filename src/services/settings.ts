import { getDb, type Executor } from '@/db/client';
import { requireHouse } from '@/db/repositories/houses';
import { getSetting, listSettings, putSetting } from '@/db/repositories/settings';
import { updateUser } from '@/db/repositories/users';
import { assertCan } from '@/lib/authz';
import { LOCALES, type Locale } from '@/lib/i18n/config';
import { THEMES, type Theme } from '@/lib/theme';
import { ValidationError } from '@/lib/errors';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { User } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Настройки сети и дома (docs/04-MODULES/11-users-settings.md).
 *
 * Ключи объявлены здесь, а не разбросаны по коду: настройка без объявленного
 * значения по умолчанию однажды прочитается как `undefined` и тихо изменит поведение.
 */
export const ORG_SETTINGS = {
  /** Суперадмин может глобально скрыть рейтинг от жильцов (§5.6). */
  ratingVisibleToResidents: {
    key: 'rating.visibleToResidents',
    defaultValue: true,
  },
  /** Локаль по умолчанию для новых учётных записей. */
  defaultLocale: {
    key: 'locale.default',
    defaultValue: 'ru' as Locale,
  },
} as const;

/**
 * Настройки дома ключей пока не имеют: всё, что фаза 2 настраивает у дома, —
 * это его собственные колонки (`default_deposit`, `curfew_time`) и таблицы
 * зон и мест. Отдельный ключ `deposit.default` здесь был вторым источником
 * той же суммы: суперадмин правил колонку, а счёт читал ключ, и значения
 * расходились молча (P2-38). Ключи со `scope=house` появятся с чек-листами
 * и рядами ротаций в фазе 4.
 */

export interface OrgSettings {
  ratingVisibleToResidents: boolean;
  defaultLocale: Locale;
}

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export async function readOrgSettings(
  actor: UserActor,
  executor: Executor = getDb(),
): Promise<OrgSettings> {
  assertCan(actor.context, 'settings.org.read');

  const rows = await listSettings(actor.context, 'org', actor.context.orgId, executor);
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const visible = byKey.get(ORG_SETTINGS.ratingVisibleToResidents.key);
  const locale = byKey.get(ORG_SETTINGS.defaultLocale.key);

  return {
    ratingVisibleToResidents:
      typeof visible === 'boolean' ? visible : ORG_SETTINGS.ratingVisibleToResidents.defaultValue,
    defaultLocale: isLocale(locale) ? locale : ORG_SETTINGS.defaultLocale.defaultValue,
  };
}

/**
 * Размер депозита по умолчанию для дома (§1.2 п.7 — 45 000 ₸, настраивается
 * на уровне дома). Источник один — колонка `houses.default_deposit` из
 * `02-DATA-MODEL.md`; правит её суперадмин в настройках сети, и ровно это
 * значение попадает в счёт.
 */
export async function readHouseDepositDefault(
  actor: UserActor,
  houseId: string,
  executor: Executor = getDb(),
): Promise<number> {
  assertCan(actor.context, 'settings.house.read', { houseId });

  const house = await requireHouse(actor.context, houseId, executor);

  return house.defaultDeposit;
}

export async function writeHouseSetting(
  actor: UserActor,
  houseId: string,
  key: string,
  value: unknown,
  executor: Executor = getDb(),
): Promise<void> {
  assertCan(actor.context, 'settings.house.write', { houseId });

  return executor.transaction(async (tx) => {
    const before = await getSetting(actor.context, 'house', houseId, key, tx);
    await putSetting(actor.context, 'house', houseId, key, value, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.settingChanged,
        entityType: 'setting',
        entityId: `house:${houseId}:${key}`,
        before: { value: before?.value ?? null },
        after: { value },
      },
      tx,
    );
  });
}

export async function writeOrgSetting(
  actor: UserActor,
  key: string,
  value: unknown,
  executor: Executor = getDb(),
): Promise<void> {
  assertCan(actor.context, 'settings.org.write');

  const known = Object.values(ORG_SETTINGS).some((setting) => setting.key === key);
  if (!known) {
    throw new ValidationError(`Неизвестная настройка: ${key}`);
  }

  await executor.transaction(async (tx) => {
    const before = await getSetting(actor.context, 'org', actor.context.orgId, key, tx);

    await putSetting(actor.context, 'org', actor.context.orgId, key, value, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.settingChanged,
        entityType: 'setting',
        before: { key, value: before?.value ?? null },
        after: { key, value },
      },
      tx,
    );
  });
}

export interface PersonalSettings {
  locale: Locale;
  theme: Theme;
}

/**
 * Личные настройки хранятся в учётной записи, а не в браузере:
 * иначе выбор не переживает смену устройства (закрывает P0-2 и P0-7).
 */
export async function savePersonalSettings(
  actor: UserActor,
  input: { locale: string; theme: string },
  executor: Executor = getDb(),
): Promise<User> {
  assertCan(actor.context, 'self.updatePreferences', { userId: actor.context.userId });

  if (!isLocale(input.locale)) {
    throw new ValidationError(`Неизвестная локаль: ${input.locale}`);
  }

  if (!isTheme(input.theme)) {
    throw new ValidationError(`Неизвестная тема: ${input.theme}`);
  }

  const updated = await updateUser(
    actor.context,
    actor.context.userId,
    { locale: input.locale, theme: input.theme },
    executor,
  );

  if (updated === null) {
    throw new ValidationError('Учётная запись не найдена');
  }

  return updated;
}
