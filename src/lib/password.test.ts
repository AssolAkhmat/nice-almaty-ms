import { describe, expect, it } from 'vitest';

import {
  generateTemporaryPassword,
  hashPassword,
  TEMPORARY_PASSWORD_ALPHABET,
  TEMPORARY_PASSWORD_LENGTH,
  verifyPassword,
} from './password';

describe('хеширование паролей', () => {
  it('использует argon2id с параметрами OWASP', async () => {
    const hash = await hashPassword('sovsem-normalny-parol');

    // Формат: $argon2id$v=19$m=19456,t=2,p=1$...
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it('один и тот же пароль даёт разные хеши — соль случайна', async () => {
    const [first, second] = await Promise.all([
      hashPassword('odinakovy-parol'),
      hashPassword('odinakovy-parol'),
    ]);

    expect(first).not.toBe(second);
  });

  it('проверяет верный пароль и отвергает неверный', async () => {
    const hash = await hashPassword('pravilny-parol');

    await expect(verifyPassword(hash, 'pravilny-parol')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'nepravilny-parol')).resolves.toBe(false);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });

  it('на испорченном хеше возвращает false, а не падает', async () => {
    await expect(verifyPassword('не хеш вовсе', 'parol-lyuboy')).resolves.toBe(false);
    await expect(verifyPassword('', 'parol-lyuboy')).resolves.toBe(false);
  });
});

describe('временный пароль', () => {
  it('двенадцать символов из алфавита без похожих начертаний', () => {
    const password = generateTemporaryPassword();

    expect(TEMPORARY_PASSWORD_LENGTH).toBe(12);
    expect(password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);

    for (const char of password) {
      expect(TEMPORARY_PASSWORD_ALPHABET, `символ ${char}`).toContain(char);
    }
  });

  it('в алфавите нет символов, которые путают при переписывании', () => {
    for (const lookalike of ['0', 'O', 'o', 'I', 'l', '1']) {
      expect(TEMPORARY_PASSWORD_ALPHABET, lookalike).not.toContain(lookalike);
    }
  });

  it('два вызова дают разные пароли', () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generateTemporaryPassword()));

    expect(passwords.size).toBe(20);
  });

  it('удовлетворяет собственным требованиям к длине пароля', () => {
    // Временный пароль пользователь меняет при первом входе, но и он не должен
    // быть короче минимума: иначе смена пароля упрётся в собственную же схему.
    expect(generateTemporaryPassword().length).toBeGreaterThanOrEqual(10);
  });

  it('отбрасывает байты, которые дали бы перекос распределения', () => {
    const alphabetSize = TEMPORARY_PASSWORD_ALPHABET.length;
    const limit = Math.floor(256 / alphabetSize) * alphabetSize;

    // Первый байт выше границы отбраковки, второй — ровно ноль.
    const scripted = [limit, 0, ...new Array<number>(64).fill(1)];
    let offset = 0;

    const password = generateTemporaryPassword((size) => {
      const chunk = Uint8Array.from(scripted.slice(offset, offset + size));
      offset += size;
      return chunk;
    });

    expect(password.charAt(0)).toBe(TEMPORARY_PASSWORD_ALPHABET.charAt(0));
    expect(password.charAt(1)).toBe(TEMPORARY_PASSWORD_ALPHABET.charAt(1));
  });
});
