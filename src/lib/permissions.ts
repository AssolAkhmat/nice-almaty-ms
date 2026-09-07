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
  'residency.terminate',
  'bed.read',
  'bed.assign',
  'invoice.read',
  'invoice.issue',
  'payment.record',
  'deposit.read',
  'damage.read',
  'damage.create',
  'damage.reverse',
  'utility.read',
  'utility.manage',
  'rotation.read',
  'rotation.manage',
  'rotation.confirm',
  'rotation.score',
  'absence.read',
  'absence.create',
  'absence.review',
  'rating.read',
  'rating.event',
  'rating.history',
  'utility.reopen',
  'accounting.read',
  'accounting.write',
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
    'residency.terminate': 'org',
    'bed.read': 'org',
    'bed.assign': 'org',
    'invoice.read': 'org',
    'invoice.issue': 'org',
    'payment.record': 'org',
    'deposit.read': 'org',
    'damage.read': 'org',
    'damage.create': 'org',
    'damage.reverse': 'org',
    'utility.read': 'org',
    'utility.manage': 'org',
    'rotation.read': 'org',
    'rotation.manage': 'org',
    'rotation.confirm': 'org',
    'rotation.score': 'org',
    'absence.read': 'org',
    'absence.create': 'org',
    'absence.review': 'org',
    'rating.read': 'org',
    'rating.event': 'org',
    'rating.history': 'org',
    'utility.reopen': 'org',
    'accounting.read': 'org',
    'accounting.write': 'org',
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
    'residency.terminate': 'house',
    'bed.read': 'house',
    'bed.assign': 'house',
    'invoice.read': 'house',
    'invoice.issue': 'house',
    'payment.record': 'house',
    'deposit.read': 'house',
    'damage.read': 'house',
    'damage.create': 'house',
    /*
     * Сторно ущерба возвращает деньги на депозиты обратной проводкой (§8).
     * Решение отменить уже проведённое списание принимает суперадмин:
     * админ дома — тот же человек, который ущерб и завёл.
     */
    'damage.reverse': 'none',
    'utility.read': 'house',
    'utility.manage': 'house',
    'rotation.read': 'house',
    'rotation.manage': 'house',
    'rotation.confirm': 'house',
    'rotation.score': 'house',
    'absence.read': 'house',
    'absence.create': 'house',
    'absence.review': 'house',
    'rating.read': 'house',
    'rating.event': 'house',
    'rating.history': 'house',
    /*
     * Переоткрытие закрытого периода меняет уже выставленные счета
     * (§4, модуль 6), поэтому остаётся за суперадмином и пишется в журнал.
     */
    'utility.reopen': 'none',
    /*
     * Бухгалтерия — дело суперадмина (модуль 10): план счетов, проводки
     * и отчёты по сети. Админ ведёт деньги дома через счета и депозиты,
     * а не через книгу проводок, и в неё не смотрит.
     */
    'accounting.read': 'none',
    'accounting.write': 'none',
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
    /*
     * Расторжение договора — действие администрации (§2.3 п.1). Жилец
     * сообщает о выезде вне приложения: иначе он закрывал бы себе доступ
     * сам и без разбора депозита.
     */
    'residency.terminate': 'none',
    /*
     * Свои счета и своё движение депозита жилец видит (модуль 1, «Депозит»),
     * но выставляет счета и отмечает платежи только админ: деньги приходят
     * не через приложение, и подтверждает их получение тот, кто их получил.
     */
    /*
     * Своё место жилец видит, чужие — нет: схема дома с занятостью — рабочий
     * инструмент админа (модуль 1). Назначает место тоже админ.
     */
    'bed.read': 'self',
    'bed.assign': 'none',
    'invoice.read': 'self',
    'invoice.issue': 'none',
    'payment.record': 'none',
    'deposit.read': 'self',
    // Свои списания жилец видит движением депозита (§8), а не списком ущербов.
    'damage.read': 'none',
    'damage.create': 'none',
    'damage.reverse': 'none',
    // Свою долю коммуналки жилец видит строкой счёта, а не экраном периода.
    'utility.read': 'none',
    'utility.manage': 'none',
    /*
     * Жилец видит расписание своего дома целиком (модуль 3, «Права»):
     * ротации соседей — это и его неделя тоже. Область — «своё»: дом
     * берётся из проживания, а не из запроса, иначе перебором домов
     * читался бы состав сети.
     */
    'rotation.read': 'self',
    'rotation.manage': 'none',
    /* Жилец подтверждает свою ротацию сам; оценку ставит только админ (§7). */
    'rotation.confirm': 'self',
    'rotation.score': 'none',
    /*
     * Отсутствие жилец подаёт сам и видит своё (§9); одобряет админ —
     * ему решать, отпускать ли, и жилец себе этого не подписывает.
     */
    'absence.read': 'self',
    'absence.create': 'self',
    'absence.review': 'none',
    /*
     * Жилец видит только своё число (§5.6): ни истории, ни детализации,
     * ни чужого рейтинга. События ставит админ, себе их не поставишь.
     */
    'rating.read': 'self',
    'rating.event': 'none',
    'rating.history': 'none',
    'utility.reopen': 'none',
    'accounting.read': 'none',
    'accounting.write': 'none',
    'settings.org.read': 'none',
    'settings.org.write': 'none',
    'settings.house.read': 'none',
    'settings.house.write': 'none',
    'audit.read': 'none',
    'self.changePassword': 'self',
    'self.updatePreferences': 'self',
  },
};
