import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * Пароли — argon2id (docs/01-ARCHITECTURE.md, «Аутентификация»).
 *
 * Параметры стоимости в ТЗ не заданы; взяты рекомендации OWASP для argon2id:
 * 19 МиБ памяти, две итерации, один поток. Зафиксировано в docs/08-DECISIONS.md.
 *
 * Модуль рассчитан на Node-рантайм: биндинг нативный, в edge его тащить нельзя.
 */
/*
 * Algorithm — ambient const enum, а при verbatimModuleSyntax к таким обращаться нельзя.
 * Поэтому значение задано числом: Argon2id = 2 в @node-rs/argon2.
 */
const ARGON2ID = 2 as Algorithm;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/** На испорченном хеше возвращает false: это отказ во входе, а не сбой сервера. */
export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Временный пароль выдаётся суперадмином и переписывается человеком с экрана,
 * поэтому из алфавита убраны символы, которые путают: 0 O o I l 1.
 * Двенадцать символов из 56 — около 70 бит.
 */
export const TEMPORARY_PASSWORD_LENGTH = 12;

export const TEMPORARY_PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Источник случайности параметризован ради тестируемости отбраковки:
 * без неё остаток от деления перекосил бы распределение в пользу
 * первых символов алфавита.
 */
export function generateTemporaryPassword(
  randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
): string {
  const alphabetSize = TEMPORARY_PASSWORD_ALPHABET.length;
  const limit = Math.floor(256 / alphabetSize) * alphabetSize;

  let password = '';
  while (password.length < TEMPORARY_PASSWORD_LENGTH) {
    for (const byte of randomBytes(TEMPORARY_PASSWORD_LENGTH)) {
      if (byte >= limit) {
        continue;
      }

      password += TEMPORARY_PASSWORD_ALPHABET.charAt(byte % alphabetSize);
      if (password.length === TEMPORARY_PASSWORD_LENGTH) {
        break;
      }
    }
  }

  return password;
}
