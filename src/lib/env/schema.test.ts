import { describe, expect, it } from 'vitest';

import { EnvError, parseEnv } from './schema';

/** 32 байта в base64 — требование к FIELD_ENCRYPTION_KEY (docs/01-ARCHITECTURE.md). */
const VALID_KEY = 'A'.repeat(43) + '=';

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DEPLOY_TARGET: 'docker',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/nice',
    APP_URL: 'http://localhost:3000',
    SESSION_SECRET: 's'.repeat(32),
    FIELD_ENCRYPTION_KEY: VALID_KEY,
    CRON_SECRET: 'c'.repeat(16),
    STORAGE_DRIVER: 'local',
    ...overrides,
  };
}

describe('разбор окружения', () => {
  it('минимальный корректный набор проходит', () => {
    const env = parseEnv(baseEnv());

    expect(env.DEPLOY_TARGET).toBe('docker');
    expect(env.STORAGE_DRIVER).toBe('local');
  });

  it('подставляет значения по умолчанию для несекретных переменных', () => {
    const env = parseEnv(baseEnv());

    expect(env.DEFAULT_LOCALE).toBe('ru');
    expect(env.TZ).toBe('Asia/Almaty');
    expect(env.LOCAL_STORAGE_PATH).toBe('./storage');
  });

  it('для секретов значений по умолчанию нет', () => {
    for (const key of ['SESSION_SECRET', 'FIELD_ENCRYPTION_KEY', 'CRON_SECRET', 'DATABASE_URL']) {
      expect(() => parseEnv(baseEnv({ [key]: undefined })), key).toThrow(EnvError);
    }
  });

  it('пустая строка означает «не задано», как в файлах .env', () => {
    const env = parseEnv(baseEnv({ DIRECT_DATABASE_URL: '', WHATSAPP_WEBHOOK_URL: '' }));

    expect(env.DIRECT_DATABASE_URL).toBeUndefined();
    expect(env.WHATSAPP_WEBHOOK_URL).toBeUndefined();
  });

  it('пустая строка не подменяет обязательный секрет', () => {
    expect(() => parseEnv(baseEnv({ SESSION_SECRET: '' }))).toThrow(/SESSION_SECRET/);
  });

  it('короткий SESSION_SECRET отвергается', () => {
    expect(() => parseEnv(baseEnv({ SESSION_SECRET: 'коротко' }))).toThrow(/SESSION_SECRET/);
  });

  it('ключ шифрования должен быть ровно 32 байтами base64', () => {
    expect(() => parseEnv(baseEnv({ FIELD_ENCRYPTION_KEY: 'QUJD' }))).toThrow(
      /FIELD_ENCRYPTION_KEY/,
    );
    expect(() => parseEnv(baseEnv({ FIELD_ENCRYPTION_KEY: 'не base64!!' }))).toThrow(
      /FIELD_ENCRYPTION_KEY/,
    );
    expect(parseEnv(baseEnv()).FIELD_ENCRYPTION_KEY).toBe(VALID_KEY);
  });

  it('строка подключения должна быть постгресовой', () => {
    expect(() => parseEnv(baseEnv({ DATABASE_URL: 'mysql://localhost/db' }))).toThrow(/postgres/);
  });

  it('неизвестная цель развёртывания отвергается', () => {
    expect(() => parseEnv(baseEnv({ DEPLOY_TARGET: 'heroku' }))).toThrow(EnvError);
  });

  describe('условные требования', () => {
    it('gdrive требует три ключа: корневую папку драйвер заводит сам', () => {
      expect(() => parseEnv(baseEnv({ STORAGE_DRIVER: 'gdrive' }))).toThrow(/GDRIVE_CLIENT_ID/);

      const env = parseEnv(
        baseEnv({
          STORAGE_DRIVER: 'gdrive',
          GDRIVE_CLIENT_ID: 'id',
          GDRIVE_CLIENT_SECRET: 'secret',
          GDRIVE_REFRESH_TOKEN: 'token',
        }),
      );

      expect(env.STORAGE_DRIVER).toBe('gdrive');
      expect(env.GDRIVE_ROOT_FOLDER_ID).toBeUndefined();
    });

    it('supabase требует url, ключ и бакет', () => {
      expect(() => parseEnv(baseEnv({ STORAGE_DRIVER: 'supabase' }))).toThrow(/SUPABASE_URL/);

      const env = parseEnv(
        baseEnv({
          STORAGE_DRIVER: 'supabase',
          SUPABASE_URL: 'https://project.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'key',
          SUPABASE_STORAGE_BUCKET: 'documents',
        }),
      );

      expect(env.SUPABASE_STORAGE_BUCKET).toBe('documents');
    });

    it('local не требует ключей внешних хранилищ', () => {
      expect(() => parseEnv(baseEnv({ STORAGE_DRIVER: 'local' }))).not.toThrow();
    });

    it('Web Push настраивается целиком или никак', () => {
      expect(() => parseEnv(baseEnv({ WEBPUSH_PUBLIC_KEY: 'pub' }))).toThrow(/Web Push/);
      expect(() =>
        parseEnv(
          baseEnv({
            WEBPUSH_PUBLIC_KEY: 'pub',
            WEBPUSH_PRIVATE_KEY: 'priv',
            WEBPUSH_SUBJECT: 'mailto:admin@example.com',
          }),
        ),
      ).not.toThrow();
    });
  });

  it('сообщение об ошибке перечисляет все проблемы разом', () => {
    try {
      parseEnv(baseEnv({ SESSION_SECRET: 'x', CRON_SECRET: 'y' }));
      expect.unreachable('разбор должен был упасть');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });
});
