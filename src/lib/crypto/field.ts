/**
 * Шифрование полей ИИН и номера УДЛ (docs/01-ARCHITECTURE.md,
 * «Безопасность данных»): AES-256-GCM на ключе `FIELD_ENCRYPTION_KEY`.
 *
 * В базе лежит `bytea` вида `вектор инициализации || шифротекст с меткой`,
 * рядом — отдельная колонка `*_last4` для поиска и показа.
 *
 * WebCrypto, а не node:crypto: тот же код работает и в edge-рантайме.
 */
const KEY_BYTES = 32;

/** Двенадцать байт — размер вектора инициализации, рекомендованный для GCM. */
const IV_BYTES = 12;

/** Метка подлинности GCM: без неё расшифровка не проверяется. */
const TAG_BYTES = 16;

export class FieldDecryptionError extends Error {
  constructor(cause?: unknown) {
    super('Не удалось расшифровать поле: данные повреждены или ключ не тот');
    this.name = 'FieldDecryptionError';
    this.cause = cause;
  }
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/**
 * WebCrypto принимает BufferSource поверх обычного ArrayBuffer, а Uint8Array
 * в современных типах параметризован произвольным хранилищем. Копия короткая:
 * речь о десятках байт, а не о файлах.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  return buffer;
}

/** Ключ из переменной окружения. Значения по умолчанию нет и быть не может. */
export async function importFieldKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;

  try {
    raw = fromBase64(base64Key);
  } catch {
    throw new RangeError('FIELD_ENCRYPTION_KEY должен быть 32 байтами в base64');
  }

  if (raw.length !== KEY_BYTES) {
    throw new RangeError('FIELD_ENCRYPTION_KEY должен быть 32 байтами в base64');
  }

  return crypto.subtle.importKey('raw', toBuffer(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptField(value: string, key: CryptoKey): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    key,
    toBuffer(new TextEncoder().encode(value)),
  );

  // Вектор инициализации кладётся рядом: он не секрет, но нужен для расшифровки.
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);

  return packed;
}

export async function decryptField(packed: Uint8Array, key: CryptoKey): Promise<string> {
  if (packed.length < IV_BYTES + TAG_BYTES) {
    throw new FieldDecryptionError('шифротекст короче минимально возможного');
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(packed.slice(0, IV_BYTES)) },
      key,
      toBuffer(packed.slice(IV_BYTES)),
    );

    return new TextDecoder().decode(plaintext);
  } catch (error) {
    // GCM проверяет метку подлинности: испорченные данные не должны
    // расшифровываться в мусор, который уйдёт дальше по коду.
    throw new FieldDecryptionError(error);
  }
}

/** Последние четыре знака — единственное, что показывается и ищется без расшифровки. */
export function last4(value: string): string {
  return value.trim().slice(-4);
}
