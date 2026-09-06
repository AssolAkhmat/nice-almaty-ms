import { loadEnv } from '@/lib/env/load';

import type { Env } from '@/lib/env/schema';

import { createGdriveStorage } from './gdrive';
import { createLocalStorage } from './local';

import type { StorageDriver, StorageHealth, StorageProvider } from './types';

export type {
  StorageDriver,
  StorageHealth,
  StorageProvider,
  StoredObject,
  UploadMeta,
  UploadTarget,
} from './types';
export { UnsafeStorageKeyError, assertSafeKey } from './paths';

/**
 * Драйвер, который нельзя собрать: `supabase` ещё не написан, у `gdrive`
 * может не хватать ключей. Проверка живости объясняет причину, а любая работа
 * с файлами — явная ошибка: молча ничего не делать хранилище не должно.
 */
function createUnavailableStorage(driver: StorageDriver, reason: string): StorageProvider {
  // Отказ приходит отклонённым обещанием, а не синхронным броском:
  // вызывающий код ловит ошибки хранилища одинаково, где бы они ни возникли.
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error(`Драйвер хранилища ${driver} недоступен: ${reason}`));

  return {
    driver,
    checkHealth: () => Promise.resolve<StorageHealth>({ status: 'error', driver, reason }),
    put: unavailable,
    get: unavailable,
    head: unavailable,
    createUploadTarget: unavailable,
    stream: unavailable,
    exists: unavailable,
    delete: unavailable,
  };
}

/**
 * Ключи Drive проверяет и схема окружения, но проверка там срабатывает лишь
 * при `STORAGE_DRIVER=gdrive`. Здесь она повторена по другой причине: драйвер
 * должен объяснять нехватку ключей словами в тот момент, когда его зовут,
 * а не падать где-то внутри запроса к Google с невнятным текстом (P2-9).
 */
export function gdriveFromEnv(env: Env): StorageProvider {
  const keys = {
    clientId: env.GDRIVE_CLIENT_ID,
    clientSecret: env.GDRIVE_CLIENT_SECRET,
    refreshToken: env.GDRIVE_REFRESH_TOKEN,
    rootFolderId: env.GDRIVE_ROOT_FOLDER_ID,
  };

  const variables: Readonly<Record<keyof typeof keys, string>> = {
    clientId: 'GDRIVE_CLIENT_ID',
    clientSecret: 'GDRIVE_CLIENT_SECRET',
    refreshToken: 'GDRIVE_REFRESH_TOKEN',
    rootFolderId: 'GDRIVE_ROOT_FOLDER_ID',
  };

  const absent = Object.entries(keys)
    .filter(([, value]) => value === undefined || value === '')
    .map(([name]) => variables[name as keyof typeof keys]);

  if (absent.length > 0) {
    return createUnavailableStorage('gdrive', `не заданы ${absent.join(', ')}`);
  }

  return createGdriveStorage({
    clientId: keys.clientId ?? '',
    clientSecret: keys.clientSecret ?? '',
    refreshToken: keys.refreshToken ?? '',
    rootFolderId: keys.rootFolderId ?? '',
  });
}

export function getStorageProvider(): StorageProvider {
  const env = loadEnv();

  switch (env.STORAGE_DRIVER) {
    case 'local':
      return createLocalStorage(env.LOCAL_STORAGE_PATH);
    case 'gdrive':
      return gdriveFromEnv(env);
    case 'supabase':
      return createUnavailableStorage('supabase', 'драйвер появится вместе с целью Vercel');
  }
}
