import { describe, expect, it } from 'vitest';

import { businessDate, parseBusinessDate } from '@/lib/time';

import {
  checkDocumentDates,
  documentPeriod,
  documentValidity,
  daysUntilExpiry,
  EXPIRY_WARNING_DAYS,
} from './documents';

/**
 * Сроки годности документов (docs/03-BUSINESS-RULES.md §1.3).
 *
 * | Фото 3×4        | бессрочно                     |
 * | Справка ПНД     | 1 год от даты загрузки        |
 * | Флюорография    | 1 год от даты снимка          |
 *
 * Тесты идут по этой таблице числами: срок документа — не догадка,
 * а прямая норма, и проверяется она именно так.
 */
const PERMANENT = { validityMonths: null, requiresIssueDate: false };
const YEAR_FROM_UPLOAD = { validityMonths: 12, requiresIssueDate: false };
const YEAR_FROM_ISSUE = { validityMonths: 12, requiresIssueDate: true };

const day = (value: string) => parseBusinessDate(value);

describe('срок действия по типу документа', () => {
  it('фото 3×4 бессрочно', () => {
    const period = documentPeriod({
      rules: PERMANENT,
      uploadedOn: day('2027-03-15'),
      issueDate: null,
    });

    expect(period.validFrom).toEqual(day('2027-03-15'));
    expect(period.validUntil).toBeNull();
  });

  it('справка — год от даты загрузки', () => {
    const period = documentPeriod({
      rules: YEAR_FROM_UPLOAD,
      uploadedOn: day('2027-03-15'),
      issueDate: null,
    });

    expect(period.validFrom).toEqual(day('2027-03-15'));
    expect(period.validUntil).toEqual(day('2028-03-15'));
  });

  it('флюорография — год от даты снимка, а не от загрузки', () => {
    const period = documentPeriod({
      rules: YEAR_FROM_ISSUE,
      uploadedOn: day('2027-02-20'),
      issueDate: day('2027-01-10'),
    });

    expect(period.validFrom).toEqual(day('2027-01-10'));
    expect(period.validUntil).toEqual(day('2028-01-10'));
  });

  it('29 февраля даёт 28 февраля: месяц без такого дня не сдвигает срок вперёд', () => {
    const period = documentPeriod({
      rules: YEAR_FROM_ISSUE,
      uploadedOn: day('2028-03-01'),
      issueDate: businessDate(2028, 2, 29),
    });

    expect(period.validUntil).toEqual(day('2029-02-28'));
  });

  it('31 число живёт в месяце из тридцати дней последним днём', () => {
    const period = documentPeriod({
      rules: { validityMonths: 1, requiresIssueDate: false },
      uploadedOn: day('2027-03-31'),
      issueDate: null,
    });

    expect(period.validUntil).toEqual(day('2027-04-30'));
  });

  it('срок, заданный суперадмином в типе, применяется как есть', () => {
    const period = documentPeriod({
      rules: { validityMonths: 6, requiresIssueDate: false },
      uploadedOn: day('2027-03-15'),
      issueDate: null,
    });

    expect(period.validUntil).toEqual(day('2027-09-15'));
  });
});

describe('обязательность даты снимка', () => {
  it('флюорография без даты снимка не принимается', () => {
    expect(
      checkDocumentDates({
        rules: YEAR_FROM_ISSUE,
        uploadedOn: day('2027-02-20'),
        issueDate: null,
      }),
    ).toBe('documents.issueDateRequired');
  });

  it('дата снимка из будущего — ошибка ввода, а не срок вперёд', () => {
    expect(
      checkDocumentDates({
        rules: YEAR_FROM_ISSUE,
        uploadedOn: day('2027-02-20'),
        issueDate: day('2027-02-21'),
      }),
    ).toBe('documents.issueDateInFuture');
  });

  it('снимок сегодняшним днём принимается', () => {
    expect(
      checkDocumentDates({
        rules: YEAR_FROM_ISSUE,
        uploadedOn: day('2027-02-20'),
        issueDate: day('2027-02-20'),
      }),
    ).toBeNull();
  });

  it('типу без даты снимка она не нужна и не мешает', () => {
    expect(
      checkDocumentDates({
        rules: YEAR_FROM_UPLOAD,
        uploadedOn: day('2027-02-20'),
        issueDate: null,
      }),
    ).toBeNull();
  });
});

describe('состояние документа на дату', () => {
  it('бессрочный документ не истекает никогда', () => {
    expect(documentValidity(null, day('2099-01-01'))).toBe('permanent');
  });

  it('в день истечения документ ещё действует', () => {
    expect(documentValidity(day('2028-03-15'), day('2028-03-15'))).toBe('expiring');
  });

  it('на следующий день — просрочен', () => {
    expect(documentValidity(day('2028-03-15'), day('2028-03-16'))).toBe('expired');
  });

  it('за тридцать дней документ считается истекающим', () => {
    expect(documentValidity(day('2028-03-15'), day('2028-02-14'))).toBe('expiring');
    expect(documentValidity(day('2028-03-15'), day('2028-02-13'))).toBe('valid');
  });

  it('порог предупреждения — тридцать дней, как в §1.3', () => {
    expect(EXPIRY_WARNING_DAYS).toBe(30);
  });
});

describe('сколько дней осталось', () => {
  it('считает дни до истечения', () => {
    expect(daysUntilExpiry(day('2028-03-15'), day('2028-03-08'))).toBe(7);
    expect(daysUntilExpiry(day('2028-03-15'), day('2028-03-15'))).toBe(0);
  });

  it('просроченный документ отдаёт отрицательное число, а не ноль', () => {
    expect(daysUntilExpiry(day('2028-03-15'), day('2028-03-18'))).toBe(-3);
  });

  it('у бессрочного документа дней до истечения нет', () => {
    expect(daysUntilExpiry(null, day('2028-03-15'))).toBeNull();
  });
});
