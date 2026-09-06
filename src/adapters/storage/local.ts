import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import { assertSafeKey, resolveWithinRoot } from './paths';

import type { StorageHealth, StorageProvider, StoredObject } from './types';

/**
 * Локальный диск: на нём идут тесты и работает разработка без доступа
 * к Google (docs/01-ARCHITECTURE.md). В проде на файловую систему писать
 * нельзя — там драйвер другой.
 */
async function isMissing(error: unknown): Promise<boolean> {
  return Promise.resolve(
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
}

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

    async put(key: string, data: Uint8Array): Promise<StoredObject> {
      const path = resolveWithinRoot(rootPath, key);

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);

      return { key: assertSafeKey(key), sizeBytes: data.byteLength };
    },

    async get(key: string): Promise<Uint8Array | null> {
      try {
        return new Uint8Array(await readFile(resolveWithinRoot(rootPath, key)));
      } catch (error) {
        if (await isMissing(error)) {
          return null;
        }

        throw error;
      }
    },

    async stream(key: string): Promise<ReadableStream<Uint8Array> | null> {
      const path = resolveWithinRoot(rootPath, key);

      try {
        await stat(path);
      } catch (error) {
        if (await isMissing(error)) {
          return null;
        }

        throw error;
      }

      return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    },

    async exists(key: string): Promise<boolean> {
      try {
        await stat(resolveWithinRoot(rootPath, key));
        return true;
      } catch (error) {
        if (await isMissing(error)) {
          return false;
        }

        throw error;
      }
    },

    async delete(key: string): Promise<void> {
      // Удаление несуществующего объекта — не ошибка: повторный вызов
      // должен быть безопасен, иначе уборка после сбоя станет невозможной.
      await rm(resolveWithinRoot(rootPath, key), { force: true });
    },
  };
}
