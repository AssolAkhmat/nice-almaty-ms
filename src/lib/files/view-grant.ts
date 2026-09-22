import { type FileDisposition } from '@/domain/files';
import { toArrayBuffer } from '@/lib/crypto/webpush';
import { loadEnv } from '@/lib/env/load';

/**
 * Пятиминутный пропуск на содержимое файла (указание владельца,
 * 22 сентября 2026: «ссылки должны жить 5 минут после просмотра»).
 *
 * Пропуск ничего не разрешает сам по себе. Он **добавляется** к проверке
 * прав, а не заменяет её: запрос с пропуском, но без сессии — отказ, запрос
 * с сессией без права на файл — отказ. Иначе получилась бы обычная публичная
 * ссылка, а таких в системе не бывает (`docs/01-ARCHITECTURE.md`).
 *
 * Зачем он тогда нужен: адрес, по которому браузер показал справку, остаётся
 * в истории вкладок и легко копируется из адресной строки. Сегодня такой
 * адрес работает столько же, сколько живёт учётная запись. С пропуском он
 * перестаёт работать через пять минут — у всех, включая того, кто открывал.
 *
 * Пропуск привязан к файлу, к человеку и к способу отдачи: чужим он
 * не подойдёт, и просмотр не превратится в скачивание подменой одной буквы
 * в адресе.
 */
export const VIEW_GRANT_TTL_SECONDS = 300;

function utf8(text: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(text));
}

export interface ViewGrantClaims {
  fileId: string;
  userId: string;
  disposition: FileDisposition;
  /** Момент истечения, секунды эпохи. */
  expiresAt: number;
}

export type { FileDisposition };

export type GrantVerdict = 'ok' | 'expired' | 'invalid';

let cached: Promise<CryptoKey> | null = null;

/**
 * Ключ подписи выводится из `SESSION_SECRET`, а не заводится отдельной
 * переменной: новый секрет в окружении — это ещё одно место, где его можно
 * забыть сменить. Отдельная метка `info` держит его непригодным для чего-либо,
 * кроме пропусков, даже если тот же секрет выведут ещё куда-то.
 */
export async function deriveViewGrantKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, [
    'deriveBits',
  ]);

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8('nice-almaty/file-view-grant'),
      info: utf8('v1'),
    },
    material,
    256,
  );

  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export function getViewGrantKey(): Promise<CryptoKey> {
  cached ??= deriveViewGrantKey(loadEnv().SESSION_SECRET);

  return cached;
}

function payload(claims: ViewGrantClaims): ArrayBuffer {
  return utf8(
    [claims.fileId, claims.userId, claims.disposition, String(claims.expiresAt)].join('\n'),
  );
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Сравнение подписей за постоянное время: длина уже известна нападающему. */
function equalsInConstantTime(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
}

export async function signViewGrant(claims: ViewGrantClaims, key: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', key, payload(claims));

  return `${String(claims.expiresAt)}.${claims.disposition}.${toHex(signature)}`;
}

/**
 * Пропуск на файл для этого человека, действующий `VIEW_GRANT_TTL_SECONDS`.
 * Момент отсчёта передаётся снаружи: прямой `Date.now()` в коде запрещён,
 * а проверять истечение без управляемых часов нечем.
 */
export async function issueViewGrant(
  target: { fileId: string; userId: string; disposition: FileDisposition },
  instant: Date,
  key: CryptoKey,
): Promise<string> {
  return signViewGrant(
    {
      ...target,
      expiresAt: Math.floor(instant.getTime() / 1000) + VIEW_GRANT_TTL_SECONDS,
    },
    key,
  );
}

export async function verifyViewGrant(
  token: string,
  target: { fileId: string; userId: string; disposition: FileDisposition },
  instant: Date,
  key: CryptoKey,
): Promise<GrantVerdict> {
  const parts = token.split('.');

  if (parts.length !== 3) {
    return 'invalid';
  }

  const [rawExpiry, disposition, signature] = parts as [string, string, string];

  if (!/^\d+$/.test(rawExpiry)) {
    return 'invalid';
  }

  const expiresAt = Number(rawExpiry);

  /*
   * Способ отдачи проверяется до подписи и сверяется с тем, что спрашивают:
   * пропуск на просмотр не должен работать как пропуск на скачивание.
   */
  if (disposition !== target.disposition) {
    return 'invalid';
  }

  const expected = await signViewGrant(
    { ...target, disposition: target.disposition, expiresAt },
    key,
  );

  if (!equalsInConstantTime(expected.split('.')[2] ?? '', signature)) {
    return 'invalid';
  }

  // Срок проверяется последним: до проверки подписи он ничего не значит.
  return Math.floor(instant.getTime() / 1000) >= expiresAt ? 'expired' : 'ok';
}
