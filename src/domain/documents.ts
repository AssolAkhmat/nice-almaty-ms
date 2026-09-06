import { addMonths, compareBusinessDates, differenceInDays, type BusinessDate } from '@/lib/time';

/**
 * Сроки годности документов (docs/03-BUSINESS-RULES.md §1.3).
 *
 * Фото 3×4 — бессрочно, справка — год от даты загрузки, флюорография — год
 * от **даты снимка**, которая вводится отдельно. Новые типы заводит суперадмин,
 * и срок у них берётся из самого типа: правило одно, значения разные.
 *
 * Чистые функции: ни БД, ни часов. «Сегодня» приходит аргументом.
 */

/** Предупреждение об истечении — за тридцать дней (§1.3, уведомления). */
export const EXPIRY_WARNING_DAYS = 30;

export interface DocumentTypeRules {
  /** `null` — бессрочно. */
  validityMonths: number | null;
  /** Срок считается от даты выдачи документа, а не от загрузки. */
  requiresIssueDate: boolean;
}

export interface DocumentDatesInput {
  rules: DocumentTypeRules;
  uploadedOn: BusinessDate;
  issueDate: BusinessDate | null;
}

export interface DocumentPeriod {
  validFrom: BusinessDate;
  validUntil: BusinessDate | null;
}

/** Причина отказа — код, а не готовый текст: перевод подставляет интерфейс. */
export type DocumentDatesError = 'documents.issueDateRequired' | 'documents.issueDateInFuture';

export function checkDocumentDates(input: DocumentDatesInput): DocumentDatesError | null {
  if (input.rules.requiresIssueDate && input.issueDate === null) {
    return 'documents.issueDateRequired';
  }

  if (input.issueDate !== null && compareBusinessDates(input.issueDate, input.uploadedOn) > 0) {
    // Снимок, сделанный завтра, — это опечатка, а не документ на год вперёд.
    return 'documents.issueDateInFuture';
  }

  return null;
}

/**
 * Начало и конец действия документа. Отсчёт идёт от даты снимка, если тип
 * её требует, и от даты загрузки во всех остальных случаях.
 */
export function documentPeriod(input: DocumentDatesInput): DocumentPeriod {
  const validFrom =
    input.rules.requiresIssueDate && input.issueDate !== null ? input.issueDate : input.uploadedOn;

  return {
    validFrom,
    validUntil:
      input.rules.validityMonths === null ? null : addMonths(validFrom, input.rules.validityMonths),
  };
}

export type DocumentValidity = 'permanent' | 'valid' | 'expiring' | 'expired';

/**
 * Состояние документа на дату.
 *
 * В день истечения документ ещё действует: уведомление §1.3 приходит
 * «в день истечения», значит этот день — последний годный, а не первый
 * просроченный.
 */
export function documentValidity(
  validUntil: BusinessDate | null,
  today: BusinessDate,
): DocumentValidity {
  if (validUntil === null) {
    return 'permanent';
  }

  const left = differenceInDays(today, validUntil);

  if (left < 0) {
    return 'expired';
  }

  return left <= EXPIRY_WARNING_DAYS ? 'expiring' : 'valid';
}

/** Дней до истечения. Отрицательное — просрочен, `null` — бессрочный. */
export function daysUntilExpiry(
  validUntil: BusinessDate | null,
  today: BusinessDate,
): number | null {
  return validUntil === null ? null : differenceInDays(today, validUntil);
}
