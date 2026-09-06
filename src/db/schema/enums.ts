import { pgEnum } from 'drizzle-orm/pg-core';

/** Роли из docs/00-PRD.md. Роль и проживание — разные сущности (D11). */
export const userRoleEnum = pgEnum('user_role', ['superadmin', 'admin', 'resident']);

/** Аккаунт нельзя удалить, только архивировать: история должна сохраняться. */
export const userStatusEnum = pgEnum('user_status', ['active', 'archived']);

export const localeEnum = pgEnum('locale', ['ru', 'kk', 'en']);

export const settingsScopeEnum = pgEnum('settings_scope', ['org', 'house']);

/**
 * Тема оформления — личная настройка из docs/04-MODULES/11-users-settings.md.
 * В `02-DATA-MODEL.md` колонки не было: настройка описана в модуле, но не в модели,
 * поэтому таблица дополнена (см. решение фазы 1 в docs/08-DECISIONS.md).
 */
export const userThemeEnum = pgEnum('user_theme', ['light', 'dark', 'system']);
