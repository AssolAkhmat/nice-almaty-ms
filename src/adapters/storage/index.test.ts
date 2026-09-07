import { describe, expect, it, vi } from 'vitest';

import { gdriveFromEnv } from './index';

import type { Env } from '@/lib/env/schema';

/**
 * Выбор драйвера по окружению.
 *
 * Нехватку ключей ловит и схема окружения (`src/lib/env/schema.test.ts`):
 * при `STORAGE_DRIVER=gdrive` процесс без них не стартует. Здесь проверяется
 * второй рубеж — что драйвер, собранный без ключей, отказывается работать
 * вслух и называет недостающие переменные, а не притворяется исправным
 * и не падает где-то внутри запроса к Google.
 */
function envWith(overrides: Partial<Env>): Env {
  return {
    STORAGE_DRIVER: 'gdrive',
    GDRIVE_CLIENT_ID: 'id',
    GDRIVE_CLIENT_SECRET: 'secret',
    GDRIVE_REFRESH_TOKEN: 'token',
    GDRIVE_ROOT_FOLDER_ID: 'folder',
    ...overrides,
  } as Env;
}

describe('драйвер gdrive из окружения', () => {
  it('с полным набором ключей собирается', () => {
    expect(gdriveFromEnv(envWith({})).driver).toBe('gdrive');
  });

  it('без ключей отвечает ошибкой, а не молчит', async () => {
    const storage = gdriveFromEnv(
      envWith({ GDRIVE_REFRESH_TOKEN: undefined, GDRIVE_CLIENT_SECRET: undefined }),
    );

    const health = await storage.checkHealth();

    expect(health.status).toBe('error');
    expect(health.status === 'error' ? health.reason : '').toContain('GDRIVE_REFRESH_TOKEN');
    expect(health.status === 'error' ? health.reason : '').toContain('GDRIVE_CLIENT_SECRET');
  });

  /*
   * Папка, созданная владельцем в браузере, драйверу не видна: область
   * `drive.file` показывает только объекты самого приложения. Поэтому
   * `GDRIVE_ROOT_FOLDER_ID` перестал быть обязательным — без него драйвер
   * заводит папку сам, и собираться он обязан как полноценный.
   */
  it('без GDRIVE_ROOT_FOLDER_ID драйвер собирается и идёт в Google', async () => {
    const requested: string[] = [];

    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      requested.push(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );

      return Promise.resolve(new Response('{}', { status: 500 }));
    });

    try {
      const storage = gdriveFromEnv(envWith({ GDRIVE_ROOT_FOLDER_ID: undefined }));

      // Отказ приходит от Google, а не от драйвера: ключей ему хватает.
      await expect(storage.head('dom-a/residency-1/photo_3x4/file.jpg')).rejects.toThrow(
        /access_token/,
      );
      expect(requested).toContain('https://oauth2.googleapis.com/token');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('каждая операция без ключей отказывает, а не возвращает пустоту', async () => {
    const storage = gdriveFromEnv(envWith({ GDRIVE_CLIENT_ID: undefined }));

    await expect(storage.head('a/b.jpg')).rejects.toThrow(/GDRIVE_CLIENT_ID/);
    await expect(storage.get('a/b.jpg')).rejects.toThrow(/GDRIVE_CLIENT_ID/);
    await expect(storage.exists('a/b.jpg')).rejects.toThrow(/GDRIVE_CLIENT_ID/);
    await expect(storage.delete('a/b.jpg')).rejects.toThrow(/GDRIVE_CLIENT_ID/);
    await expect(
      storage.createUploadTarget('a/b.jpg', { mime: 'image/jpeg', sizeBytes: 1 }),
    ).rejects.toThrow(/GDRIVE_CLIENT_ID/);
  });

  it('пустая строка — это не заданный ключ: так его гасит .env', async () => {
    const storage = gdriveFromEnv(envWith({ GDRIVE_CLIENT_SECRET: '' }));

    expect((await storage.checkHealth()).status).toBe('error');
  });
});
