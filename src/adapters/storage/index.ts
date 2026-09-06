import { loadEnv } from '@/lib/env/load';

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
 * Драйверы gdrive и supabase реализуются в фазе 2 (docs/07-ROADMAP.md).
 * Проверка живости отвечает `skipped`, а любая работа с файлами — явной
 * ошибкой: молча ничего не делать хранилище не должно.
 */
function createPendingStorage(driver: StorageDriver): StorageProvider {
  const notImplemented = (): never => {
    throw new Error(`Драйвер хранилища ${driver} будет реализован в фазе 2`);
  };

  return {
    driver,
    checkHealth: () =>
      Promise.resolve<StorageHealth>({
        status: 'skipped',
        driver,
        reason: 'Драйвер будет реализован в фазе 2',
      }),
    put: notImplemented,
    get: notImplemented,
    head: notImplemented,
    createUploadTarget: notImplemented,
    stream: notImplemented,
    exists: notImplemented,
    delete: notImplemented,
  };
}

export function getStorageProvider(): StorageProvider {
  const env = loadEnv();

  switch (env.STORAGE_DRIVER) {
    case 'local':
      return createLocalStorage(env.LOCAL_STORAGE_PATH);
    case 'gdrive':
    case 'supabase':
      return createPendingStorage(env.STORAGE_DRIVER);
  }
}
