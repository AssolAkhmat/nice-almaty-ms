import { z } from 'zod';

import { tryNormalizePhone } from '@/domain/phone';

/**
 * Требования к паролю (docs/08-DECISIONS.md, P1-3).
 * Схема одна на клиент и сервер. Сообщения — коды: текст подставляет
 * интерфейс из ключей `validation.*`, иначе строки оказались бы захардкожены.
 *
 * Совпадение с предыдущим паролем клиент проверить не может — у него нет хеша.
 * Эту проверку сервер делает отдельно, сверяя новый пароль со старым хешем.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const PasswordIssue = {
  TooShort: 'password.tooShort',
  TooLong: 'password.tooLong',
  SameAsPhone: 'password.sameAsPhone',
  Reused: 'password.reused',
} as const;

export interface PasswordContext {
  /** Телефон владельца аккаунта в любой записи. */
  phone?: string;
  /** Значения, с которыми пароль не должен совпадать: временный, предыдущий. */
  forbidden?: readonly (string | undefined)[];
}

/** Совпадает ли значение с телефоном в любой из привычных форм записи. */
function matchesPhone(value: string, phone: string): boolean {
  const normalizedPhone = tryNormalizePhone(phone);
  if (normalizedPhone === null) {
    return false;
  }

  return tryNormalizePhone(value) === normalizedPhone;
}

export function passwordSchema(context: PasswordContext = {}): z.ZodType<string> {
  const forbidden = (context.forbidden ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  return z
    .string()
    .min(PASSWORD_MIN_LENGTH, PasswordIssue.TooShort)
    .max(PASSWORD_MAX_LENGTH, PasswordIssue.TooLong)
    .refine(
      (value) => context.phone === undefined || !matchesPhone(value, context.phone),
      PasswordIssue.SameAsPhone,
    )
    .refine((value) => !forbidden.includes(value), PasswordIssue.Reused);
}

export type PasswordIssueCode = (typeof PasswordIssue)[keyof typeof PasswordIssue];
