import { businessDate, businessDateToParts, type BusinessDate } from '@/lib/time';

/**
 * Срок договора (docs/03-BUSINESS-RULES.md §1.1).
 *
 * Учебный год у сети считается от первого июля, поэтому граница правила
 * проходит между июнем и июлем: заезд 30 июня заканчивается через день,
 * заезд 1 июля — через год. Дата подставляется автоматически, но админ
 * и суперадмин могут её изменить вручную.
 *
 * Чистая функция: ни БД, ни часов.
 */
const CONTRACT_END_MONTH = 7;
const CONTRACT_END_DAY = 1;

export function contractEndDate(start: BusinessDate): BusinessDate {
  const { year, month } = businessDateToParts(start);

  const endYear = month < CONTRACT_END_MONTH ? year : year + 1;

  return businessDate(endYear, CONTRACT_END_MONTH, CONTRACT_END_DAY);
}
