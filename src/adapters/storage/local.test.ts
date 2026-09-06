import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createLocalStorage } from './local';
import { UnsafeStorageKeyError } from './paths';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function freshStorage() {
  const root = mkdtempSync(join(tmpdir(), 'nice-storage-'));
  roots.push(root);

  return { root, storage: createLocalStorage(root) };
}

const CONTENT = new TextEncoder().encode('содержимое документа');

describe('локальное хранилище', () => {
  let root: string;
  let storage: ReturnType<typeof createLocalStorage>;

  beforeEach(() => {
    ({ root, storage } = freshStorage());
  });

  it('кладёт и отдаёт объект', async () => {
    const stored = await storage.put('dom-1/residency-1/passport/scan.bin', CONTENT);

    expect(stored.key).toBe('dom-1/residency-1/passport/scan.bin');
    expect(stored.sizeBytes).toBe(CONTENT.byteLength);

    const read = await storage.get('dom-1/residency-1/passport/scan.bin');
    expect(read).toEqual(CONTENT);
  });

  it('создаёт вложенные каталоги сам', async () => {
    await storage.put('a/b/c/d.bin', CONTENT);

    expect(readFileSync(join(root, 'a', 'b', 'c', 'd.bin'))).toEqual(Buffer.from(CONTENT));
  });

  it('перезаписывает объект по тому же ключу', async () => {
    const next = new TextEncoder().encode('другое содержимое');

    await storage.put('doc.bin', CONTENT);
    await storage.put('doc.bin', next);

    expect(await storage.get('doc.bin')).toEqual(next);
  });

  it('отсутствующий объект — null, а не исключение', async () => {
    await expect(storage.get('net-takogo.bin')).resolves.toBeNull();
    await expect(storage.stream('net-takogo.bin')).resolves.toBeNull();
    await expect(storage.exists('net-takogo.bin')).resolves.toBe(false);
  });

  it('отдаёт объект потоком', async () => {
    await storage.put('big.bin', CONTENT);

    const stream = await storage.stream('big.bin');
    expect(stream).not.toBeNull();

    const chunks: Uint8Array[] = [];
    const reader = (stream as ReadableStream<Uint8Array>).getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }

    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(CONTENT));
  });

  it('удаление повторяемо: второй раз тоже не ошибка', async () => {
    await storage.put('doc.bin', CONTENT);

    await expect(storage.delete('doc.bin')).resolves.toBeUndefined();
    await expect(storage.delete('doc.bin')).resolves.toBeUndefined();
    await expect(storage.exists('doc.bin')).resolves.toBe(false);
  });

  it('проверка живости пишет и убирает за собой', async () => {
    await expect(storage.checkHealth()).resolves.toEqual({ status: 'ok', driver: 'local' });
  });

  /**
   * Главное свойство: за пределы корня хранилище не выпускает.
   * Ключ приходит из данных, и однажды он окажется не таким, как ожидалось.
   */
  describe('не выходит за пределы корня', () => {
    it('не читает файл снаружи, даже если он существует', async () => {
      const outside = join(root, '..', 'snaruzhi.bin');
      writeFileSync(outside, 'секрет', 'utf8');

      await expect(storage.get('../snaruzhi.bin')).rejects.toBeInstanceOf(UnsafeStorageKeyError);

      // Файл на месте: попытка чтения не должна была ничего задеть.
      expect(readFileSync(outside, 'utf8')).toBe('секрет');
      rmSync(outside, { force: true });
    });

    it('не пишет наружу', async () => {
      await expect(storage.put('../snaruzhi.bin', CONTENT)).rejects.toBeInstanceOf(
        UnsafeStorageKeyError,
      );
    });

    it('не удаляет наружу', async () => {
      await expect(storage.delete('../snaruzhi.bin')).rejects.toBeInstanceOf(UnsafeStorageKeyError);
    });
  });
});
