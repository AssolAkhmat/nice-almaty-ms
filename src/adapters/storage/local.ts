import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StorageHealth, StorageProvider } from './types';

/**
 * Локальный диск: на нём идут тесты и работает разработка без доступа
 * к Google (docs/01-ARCHITECTURE.md). В проде на файловую систему
 * писать нельзя — там драйвер другой.
 */
export function createLocalStorage(rootPath: string): StorageProvider {
  return {
    driver: 'local',

    async checkHealth(): Promise<StorageHealth> {
      const probe = join(rootPath, '.health-probe');

      try {
        await mkdir(rootPath, { recursive: true });
        await writeFile(probe, 'ok', 'utf8');
        await rm(probe, { force: true });

        return { status: 'ok', driver: 'local' };
      } catch (error) {
        return {
          status: 'error',
          driver: 'local',
          reason: error instanceof Error ? error.message : 'не удалось записать в хранилище',
        };
      }
    },
  };
}
