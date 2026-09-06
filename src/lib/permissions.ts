import type { AccessRole } from '@/db/access';

/**
 * Матрица прав — данные, а не код (docs/08-DECISIONS.md, P1-4).
 * `authz.ts` собственной логики не содержит и читает только этот объект.
 *
 * Источник: docs/00-PRD.md (роли) и docs/04-MODULES/11-users-settings.md.
 */

/** Над каким множеством объектов роль вправе выполнять действие. */
export type PermissionScope =
  /** Запрещено. */
  | 'none'
  /** Только собственная запись. */
  | 'self'
  /** Объекты своего дома. */
  | 'house'
  /** Любые объекты своей сети. */
  | 'org';

export const ACTIONS = [
  'house.read',
  'house.create',
  'house.update',
  'house.archive',
  'user.read',
  'user.create',
  'user.updateProfile',
  'user.changeRole',
  'user.moveAdmin',
  'user.archive',
  'user.allowPasswordReset',
  'resident.revealSensitive',
  'file.upload',
  'file.read',
  'document.upload',
  'document.review',
  'contract.generate',
  'contract.sign',
  'residency.issueKeys',
  'settings.org.read',
  'settings.org.write',
  'settings.house.read',
  'settings.house.write',
  'audit.read',
  'self.changePassword',
  'self.updatePreferences',
] as const;

export type Action = (typeof ACTIONS)[number];

export type PermissionMatrix = Readonly<
  Record<AccessRole, Readonly<Record<Action, PermissionScope>>>
>;

/**
 * Жилец в фазе 1 не связан с домом: связь идёт через проживание,
 * которое появится в фазе 2. Поэтому `house.read` у него пока `none`.
 */
export const PERMISSIONS: PermissionMatrix = {
  superadmin: {
    'house.read': 'org',
    'house.create': 'org',
    'house.update': 'org',
    'house.archive': 'org',
    'user.read': 'org',
    'user.create': 'org',
    'user.updateProfile': 'org',
    'user.changeRole': 'org',
    'user.moveAdmin': 'org',
    'user.archive': 'org',
    'user.allowPasswordReset': 'org',
    'resident.revealSensitive': 'org',
    'file.upload': 'org',
    'file.read': 'org',
    'document.upload': 'org',
    'document.review': 'org',
    'contract.generate': 'org',
    // Подпись личная: за жильца её не ставит никто, даже суперадмин.
    'contract.sign': 'none',
    'residency.issueKeys': 'org',
    'settings.org.read': 'org',
    'settings.org.write': 'org',
    'settings.house.read': 'org',
    'settings.house.write': 'org',
    'audit.read': 'org',
    'self.changePassword': 'self',
    'self.updatePreferences': 'self',
  },
  admin: {
    'house.read': 'house',
    // Дома заводит и архивирует только суперадмин (модуль 11, «Настройки сети»).
    'house.create': 'none',
    'house.update': 'none',
    'house.archive': 'none',
    'user.read': 'house',
    'user.create': 'none',
    // Админ вправе менять любой пункт профиля жильца своего дома (модуль 1).
    'user.updateProfile': 'house',
    'user.changeRole': 'none',
    'user.moveAdmin': 'none',
    'user.archive': 'none',
    'user.allowPasswordReset': 'house',
    'resident.revealSensitive': 'house',
    'file.upload': 'house',
    'file.read': 'house',
    'document.upload': 'house',
    'document.review': 'house',
    'contract.generate': 'house',
    'contract.sign': 'none',
    'residency.issueKeys': 'house',
    'settings.org.read': 'none',
    'settings.org.write': 'none',
    'settings.house.read': 'house',
    'settings.house.write': 'house',
    // Журнал аудита читает только суперадмин (§11).
    'audit.read': 'none',
    'self.changePassword': 'self',
    'self.updatePreferences': 'self',
  },
  resident: {
    'house.read': 'none',
    'house.create': 'none',
    'house.update': 'none',
    'house.archive': 'none',
    'user.read': 'self',
    'user.create': 'none',
    'user.updateProfile': 'self',
    'user.changeRole': 'none',
    'user.moveAdmin': 'none',
    'user.archive': 'none',
    'user.allowPasswordReset': 'none',
    /*
     * Свои ИИН и УДЛ жилец вправе увидеть: он их и вводил, а вечная маска
     * на собственных данных — дефект, а не защита. Раскрытие всё равно
     * пишется в журнал, независимо от роли.
     */
    'resident.revealSensitive': 'self',
    /*
     * Свои документы жилец и загружает, и открывает; чужие — нет.
     * Публичных ссылок на файлы не бывает вовсе (docs/01-ARCHITECTURE.md),
     * поэтому отдача содержимого — такое же проверяемое действие, как чтение.
     */
    'file.upload': 'self',
    'file.read': 'self',
    'document.upload': 'self',
    /*
     * Свои документы жилец не проверяет: принять или отклонить справку
     * может только админ дома или суперадмин (модуль 1, «Карточка жильца»).
     */
    'document.review': 'none',
    /*
     * Договор жильцу собирает админ (модуль 1: жилец видит PDF и подписывает),
     * а подпись ставит только он сам и только свою.
     */
    'contract.generate': 'none',
    'contract.sign': 'self',
    'residency.issueKeys': 'none',
    'settings.org.read': 'none',
    'settings.org.write': 'none',
    'settings.house.read': 'none',
    'settings.house.write': 'none',
    'audit.read': 'none',
    'self.changePassword': 'self',
    'self.updatePreferences': 'self',
  },
};
