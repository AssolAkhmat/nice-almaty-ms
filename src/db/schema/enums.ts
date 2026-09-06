import { pgEnum } from 'drizzle-orm/pg-core';

/** Роли из docs/00-PRD.md. Роль и проживание — разные сущности (D11). */
export const userRoleEnum = pgEnum('user_role', ['superadmin', 'admin', 'resident']);

/** Аккаунт нельзя удалить, только архивировать: история должна сохраняться. */
export const userStatusEnum = pgEnum('user_status', ['active', 'archived']);

export const localeEnum = pgEnum('locale', ['ru', 'kk', 'en']);

export const settingsScopeEnum = pgEnum('settings_scope', ['org', 'house']);
