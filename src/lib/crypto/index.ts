import { loadEnv } from '@/lib/env/load';

import { importFieldKey } from './field';

export { decryptField, encryptField, FieldDecryptionError, importFieldKey, last4 } from './field';

let cached: Promise<CryptoKey> | null = null;

/**
 * Ключ шифрования полей из окружения. Импорт ключа кешируется:
 * он не меняется в пределах процесса, а importKey не бесплатен.
 */
export function getFieldKey(): Promise<CryptoKey> {
  cached ??= importFieldKey(loadEnv().FIELD_ENCRYPTION_KEY);

  return cached;
}
