import { describe, expect, it } from 'vitest';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
  PasswordIssue,
} from './password';

/**
 * Требования к паролю — решение P1-3 в docs/08-DECISIONS.md:
 * от 10 до 128 символов, без требований к классам символов,
 * запрет совпадения с телефоном, с временным и с предыдущим паролем.
 *
 * Схема одна на клиент и сервер, поэтому сообщения — коды, а не готовый текст:
 * перевод подставляет интерфейс.
 */
function issuesOf(value: string, context?: Parameters<typeof passwordSchema>[0]): string[] {
  const result = passwordSchema(context).safeParse(value);

  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('правила пароля', () => {
  it('границы длины', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(PASSWORD_MAX_LENGTH).toBe(128);

    expect(issuesOf('a'.repeat(9))).toContain(PasswordIssue.TooShort);
    expect(issuesOf('a'.repeat(10))).toEqual([]);
    expect(issuesOf('a'.repeat(128))).toEqual([]);
    expect(issuesOf('a'.repeat(129))).toContain(PasswordIssue.TooLong);
  });

  it('к составу символов требований нет', () => {
    expect(issuesOf('парольпароль')).toEqual([]);
    expect(issuesOf('aaaaaaaaaa')).toEqual([]);
    expect(issuesOf('0123456789')).toEqual([]);
  });

  it('пароль не может совпадать с номером телефона в любой его записи', () => {
    const context = { phone: '+77011234567' };

    expect(issuesOf('+77011234567', context)).toContain(PasswordIssue.SameAsPhone);
    expect(issuesOf('87011234567', context)).toContain(PasswordIssue.SameAsPhone);
    expect(issuesOf('77011234567', context)).toContain(PasswordIssue.SameAsPhone);
    expect(issuesOf('7011234567', context)).toContain(PasswordIssue.SameAsPhone);
  });

  it('чужой номер телефона паролем быть может', () => {
    expect(issuesOf('87019998877', { phone: '+77011234567' })).toEqual([]);
  });

  it('пароль не может совпадать с временным или предыдущим', () => {
    const context = { forbidden: ['Vremenniy12', 'PredydushiyParol'] };

    expect(issuesOf('Vremenniy12', context)).toContain(PasswordIssue.Reused);
    expect(issuesOf('PredydushiyParol', context)).toContain(PasswordIssue.Reused);
    expect(issuesOf('SovsemDrugoy77', context)).toEqual([]);
  });

  it('пустые значения в запрещённых не блокируют всё подряд', () => {
    expect(issuesOf('normalnyparol', { forbidden: ['', undefined as unknown as string] })).toEqual(
      [],
    );
  });

  it('нарушения сообщаются кодами, а не готовым текстом', () => {
    for (const issue of issuesOf('123', { phone: '+77011234567' })) {
      expect(issue).toMatch(/^password\./);
    }
  });
});
