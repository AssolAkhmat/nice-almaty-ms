import { describe, expect, it } from 'vitest';

import {
  encryptPushPayload,
  fromBase64Url,
  toArrayBuffer,
  toBase64Url,
  vapidAuthorization,
  type VapidKeys,
} from './webpush';

/**
 * Web Push: шифрование сообщения (RFC 8291) и подпись VAPID (RFC 8292).
 *
 * Проверка идёт со стороны браузера: тест заводит пару подписчика, отдаёт
 * серверу только публичную часть и расшифровывает полученное тело так же,
 * как это сделал бы service worker. Если бы сервер положил в заголовок не
 * тот ключ или перепутал длины — расшифровка бы не сошлась.
 */
const TEXT = 'Подтвердите уборку двора до 23:55';

interface Subscriber {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  auth: Uint8Array;
}

async function subscriber(): Promise<Subscriber> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));

  return { privateKey: pair.privateKey, publicRaw, auth };
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
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

/** Расшифровка на стороне подписчика: ровно то, что делает service worker. */
async function decrypt(body: Uint8Array, target: Subscriber): Promise<string> {
  const salt = body.slice(0, 16);
  const keyLength = body[20] ?? 0;
  const serverPublicRaw = body.slice(21, 21 + keyLength);
  const ciphertext = body.slice(21 + keyLength);

  const serverPublic = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(serverPublicRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPublic }, target.privateKey, 256),
  );

  const keyInfo = concat(
    utf8('WebPush: info'),
    new Uint8Array([0]),
    target.publicRaw,
    serverPublicRaw,
  );
  const ikm = await hkdf(shared, target.auth, keyInfo, 32);
  const cek = await hkdf(ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(cek), 'AES-GCM', false, [
    'decrypt',
  ]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
      aesKey,
      toArrayBuffer(ciphertext),
    ),
  );

  // Последний байт записи — разделитель 0x02: он не часть текста.
  expect(plain[plain.length - 1]).toBe(2);

  return new TextDecoder().decode(plain.slice(0, -1));
}

async function vapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

  return {
    publicKey: toBase64Url(publicRaw),
    privateKey: jwk.d ?? '',
    subject: 'mailto:admin@nice-almaty.kz',
  };
}

describe('шифрование сообщения', () => {
  it('подписчик расшифровывает то, что зашифровал сервер', async () => {
    const target = await subscriber();

    const body = await encryptPushPayload(TEXT, {
      p256dh: toBase64Url(target.publicRaw),
      auth: toBase64Url(target.auth),
    });

    expect(await decrypt(body, target)).toBe(TEXT);
  });

  it('тело начинается заголовком aes128gcm: соль, размер записи, ключ сервера', async () => {
    const target = await subscriber();

    const body = await encryptPushPayload(TEXT, {
      p256dh: toBase64Url(target.publicRaw),
      auth: toBase64Url(target.auth),
    });

    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    // Соль, размер, длина ключа, сам ключ, шифротекст с меткой GCM.
    expect(body.length).toBeGreaterThan(16 + 4 + 1 + 65);
  });

  it('два сообщения не совпадают: соль и ключ сервера одноразовые', async () => {
    const target = await subscriber();
    const keys = { p256dh: toBase64Url(target.publicRaw), auth: toBase64Url(target.auth) };

    const first = await encryptPushPayload(TEXT, keys);
    const second = await encryptPushPayload(TEXT, keys);

    expect(toBase64Url(first)).not.toBe(toBase64Url(second));
  });
});

describe('подпись VAPID', () => {
  it('заголовок несёт токен и публичный ключ', async () => {
    const keys = await vapidKeys();

    const header = await vapidAuthorization(
      'https://push.example.com/send/abc',
      keys,
      new Date('2026-09-07T12:00:00Z'),
    );

    expect(header.startsWith('vapid t=')).toBe(true);
    expect(header).toContain(`k=${keys.publicKey}`);
  });

  it('токен подписан ключом сети и адресован push-сервису', async () => {
    const keys = await vapidKeys();
    const expiresAt = new Date('2026-09-07T12:00:00Z');

    const header = await vapidAuthorization(
      'https://push.example.com/send/abc?token=1',
      keys,
      expiresAt,
    );
    const token = header.slice('vapid t='.length).split(',')[0] ?? '';
    const [rawHeader, rawPayload, rawSignature] = token.split('.');

    const claims: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(rawPayload ?? '')));
    expect(claims).toEqual({
      aud: 'https://push.example.com',
      exp: Math.floor(expiresAt.getTime() / 1000),
      sub: keys.subject,
    });

    const publicKey = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(fromBase64Url(keys.publicKey)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const signed = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      toArrayBuffer(fromBase64Url(rawSignature ?? '')),
      toArrayBuffer(new TextEncoder().encode(`${rawHeader}.${rawPayload}`)),
    );

    expect(signed).toBe(true);
  });
});

describe('base64url', () => {
  it('кодирование и разбор возвращают те же байты', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);

    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it('в записи нет символов, требующих экранирования в URL', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(64));

    expect(toBase64Url(bytes)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
