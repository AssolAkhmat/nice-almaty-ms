import { loadEnv } from '@/lib/env/load';

import { createLocalStorage } from './local';

import type { StorageDriver, StorageHealth, StorageProvider } from './types';

export type { StorageDriver, StorageHealth, StorageProvider } from './types';

/** Драйверы gdrive и supabase реализуются в фазе 2 (docs/07-ROADMAP.md). */
function createPendingStorage(driver: StorageDriver): StorageProvider {
  return {
    driver,
    checkHealth: () =>
      Promise.resolve<StorageHealth>({
        status: 'skipped',
        driver,
        reason: 'Драйвер будет реализован в фазе 2',
      }),
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
