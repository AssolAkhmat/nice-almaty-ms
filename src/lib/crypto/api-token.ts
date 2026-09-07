/**
 * Токены API: выпуск значения и его хеш (docs/06-API.md).
 *
 * Хеш — SHA-256 без соли, а не argon2, как у паролей. Разница в том,
 * что защищает: пароль придумывает человек, и его подбирают по словарю —
 * там нужен медленный хеш. Токен выдаёт система: тридцать два случайных
 * байта не подбираются вовсе, а медленный хеш пришлось бы считать
 * на каждом запросе бота. Соли нет по той же причине: одинаковых токенов
 * не бывает, и радужная таблица для такого пространства не существует.
 *
 * WebCrypto, а не `node:crypto`: тот же код работает и в edge-рантайме.
 */
const TOKEN_BYTES = 32;

/** Префикс в значении: по нему токен узнают в логах и в чужом коде. */
export const TOKEN_PREFIX = 'nak_';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Новое значение токена. Показывается один раз и в базу не попадает. */
export function generateApiToken(): string {
  return TOKEN_PREFIX + toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export async function hashApiToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  const digest = await crypto.subtle.digest('SHA-256', buffer);

  return toBase64Url(new Uint8Array(digest));
}
