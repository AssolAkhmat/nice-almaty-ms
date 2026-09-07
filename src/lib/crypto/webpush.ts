/**
 * Web Push: шифрование сообщения (RFC 8291) и подпись VAPID (RFC 8292).
 *
 * Своя реализация, а не библиотека: нужны ровно две вещи — конверт
 * `aes128gcm` и подписанный токен, — и обе целиком укладываются в WebCrypto.
 * WebCrypto, а не `node:crypto`, по той же причине, что и в `field.ts`:
 * тот же код работает и в edge-рантайме (CLAUDE.md §5).
 *
 * Здесь нет ни сети, ни базы: адаптер `src/adapters/notify/webpush.ts`
 * берёт готовое тело и заголовок и отправляет их сам.
 */

/** Размер записи из RFC 8188: одно уведомление всегда короче. */
const RECORD_SIZE = 4096;

/** Несжатая точка P-256: 0x04 и две координаты по 32 байта. */
const PUBLIC_KEY_BYTES = 65;

const SALT_BYTES = 16;

/** Токен VAPID живёт двенадцать часов: дольше не разрешает RFC 8292. */
export const VAPID_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export interface VapidKeys {
  /** Публичный ключ сети, base64url: его же браузер передаёт в подписку. */
  publicKey: string;
  /** Приватный ключ, base64url скаляра d. */
  privateKey: string;
  /** Контакт владельца сети: `mailto:` или `https:` по RFC 8292. */
  subject: string;
}

export interface SubscriptionKeys {
  /** Публичный ключ браузера, base64url. */
  p256dh: string;
  /** Секрет подписки, base64url, шестнадцать байт. */
  auth: string;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * WebCrypto принимает BufferSource поверх обычного ArrayBuffer, а Uint8Array
 * в современных типах параметризован произвольным хранилищем.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  return buffer;
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(ikm), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
    key,
    bytes * 8,
  );

  return new Uint8Array(bits);
}

/**
 * Конверт `aes128gcm` для одной подписки (RFC 8291, §3.4).
 *
 * Ключ шифрования выводится из общего секрета ECDH и секрета подписки:
 * push-сервис переносит тело, но прочитать его не может — у него нет
 * приватного ключа браузера. Соль и ключ сервера одноразовые, поэтому
 * два одинаковых текста дают разные тела.
 */
export async function encryptPushPayload(
  payload: string,
  subscription: SubscriptionKeys,
): Promise<Uint8Array> {
  const clientPublicRaw = fromBase64Url(subscription.p256dh);
  const auth = fromBase64Url(subscription.auth);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const server = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const serverPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey));

  const clientPublic = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(clientPublicRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublic }, server.privateKey, 256),
  );

  /*
   * Порядок ключей в `key_info` задан спецификацией и несимметричен:
   * сначала ключ браузера, потом ключ сервера. Перестановка даёт другой
   * ключ шифрования, и сообщение молча не расшифруется на телефоне.
   */
  const keyInfo = concat(
    utf8('WebPush: info'),
    new Uint8Array([0]),
    clientPublicRaw,
    serverPublicRaw,
  );
  const ikm = await hkdf(shared, auth, keyInfo, 32);
  const contentKey = await hkdf(ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(contentKey), 'AES-GCM', false, [
    'encrypt',
  ]);
  // Байт 0x02 закрывает последнюю запись: без него запись считается неполной.
  const record = concat(utf8(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
      aesKey,
      toArrayBuffer(record),
    ),
  );

  const header = new Uint8Array(SALT_BYTES + 4 + 1 + PUBLIC_KEY_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_BYTES, RECORD_SIZE);
  header[SALT_BYTES + 4] = PUBLIC_KEY_BYTES;
  header.set(serverPublicRaw, SALT_BYTES + 5);

  return concat(header, ciphertext);
}

/** Адресат токена — сам push-сервис, без пути подписки: он в токене лишний. */
function audienceOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

async function importVapidPrivateKey(keys: VapidKeys): Promise<CryptoKey> {
  const publicRaw = fromBase64Url(keys.publicKey);

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: toBase64Url(publicRaw.slice(1, 33)),
      y: toBase64Url(publicRaw.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * Заголовок `Authorization` для push-сервиса (RFC 8292, §3).
 *
 * Токен доказывает, что уведомление отправила именно эта сеть: подписка
 * привязана к публичному ключу, и с чужим ключом push-сервис её не примет.
 */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  expiresAt: Date,
): Promise<string> {
  const header = toBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(
    utf8(
      JSON.stringify({
        aud: audienceOf(endpoint),
        exp: Math.floor(expiresAt.getTime() / 1000),
        sub: keys.subject,
      }),
    ),
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importVapidPrivateKey(keys),
      toArrayBuffer(utf8(`${header}.${claims}`)),
    ),
  );

  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}
