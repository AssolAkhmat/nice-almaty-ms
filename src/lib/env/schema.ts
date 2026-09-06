import { z } from 'zod';

import { ALMATY_TIME_ZONE } from '@/lib/time';
import { DEFAULT_LOCALE, LOCALES } from '@/lib/i18n/config';

/**
 * Переменные окружения из docs/01-ARCHITECTURE.md.
 * Значений по умолчанию для секретов нет — это требование CLAUDE.md §5.
 * Условные требования проверяются после разбора: набор ключей зависит
 * от выбранного драйвера хранилища.
 */

const POSTGRES_URL = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'Строка подключения должна начинаться с postgres:// или postgresql://',
  );

/** Ключ шифрования полей — ровно 32 байта, закодированные base64 (AES-256-GCM). */
const FIELD_KEY = z.string().refine((value) => {
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
}, 'FIELD_ENCRYPTION_KEY должен быть 32 байтами в base64');

export const envSchema = z.object({
  DEPLOY_TARGET: z.enum(['docker', 'vercel']),

  DATABASE_URL: POSTGRES_URL,
  /** Прямое подключение в обход пулера — нужно drizzle-kit на Supabase. */
  DIRECT_DATABASE_URL: POSTGRES_URL.optional(),

  APP_URL: z.url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET короче 32 символов'),
  FIELD_ENCRYPTION_KEY: FIELD_KEY,
  CRON_SECRET: z.string().min(16, 'CRON_SECRET короче 16 символов'),

  DEFAULT_LOCALE: z.enum(LOCALES).default(DEFAULT_LOCALE),
  /** Бизнес-логика не зависит от системной зоны: расчёты идут через src/lib/time.ts. */
  TZ: z.string().default(ALMATY_TIME_ZONE),

  STORAGE_DRIVER: z.enum(['gdrive', 'local', 'supabase']),
  GDRIVE_CLIENT_ID: z.string().min(1).optional(),
  GDRIVE_CLIENT_SECRET: z.string().min(1).optional(),
  GDRIVE_REFRESH_TOKEN: z.string().min(1).optional(),
  GDRIVE_ROOT_FOLDER_ID: z.string().min(1).optional(),
  LOCAL_STORAGE_PATH: z.string().min(1).default('./storage'),

  /**
   * Путь к chromium для печати договора. Пусто — ищет сам puppeteer:
   * в образе браузер лежит по стандартному пути, на машине разработчика
   * его может не быть вовсе, и тогда печать честно откажет (P2-15).
   */
  CHROMIUM_PATH: z.string().min(1).optional(),

  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).optional(),

  WEBPUSH_PUBLIC_KEY: z.string().min(1).optional(),
  WEBPUSH_PRIVATE_KEY: z.string().min(1).optional(),
  WEBPUSH_SUBJECT: z.string().min(1).optional(),

  WHATSAPP_WEBHOOK_URL: z.url().optional(),
});

export type Env = z.infer<typeof envSchema>;

const GDRIVE_KEYS = [
  'GDRIVE_CLIENT_ID',
  'GDRIVE_CLIENT_SECRET',
  'GDRIVE_REFRESH_TOKEN',
  'GDRIVE_ROOT_FOLDER_ID',
] as const;

const SUPABASE_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET',
] as const;

const WEBPUSH_KEYS = ['WEBPUSH_PUBLIC_KEY', 'WEBPUSH_PRIVATE_KEY', 'WEBPUSH_SUBJECT'] as const;

function missing(env: Env, keys: readonly (keyof Env)[]): string[] {
  return keys.filter((key) => env[key] === undefined);
}

/** Требования, зависящие от выбранных драйверов. */
function checkConditional(env: Env): string[] {
  const problems: string[] = [];

  if (env.STORAGE_DRIVER === 'gdrive') {
    const absent = missing(env, GDRIVE_KEYS);
    if (absent.length > 0) {
      problems.push(`STORAGE_DRIVER=gdrive требует: ${absent.join(', ')}`);
    }
  }

  if (env.STORAGE_DRIVER === 'supabase') {
    const absent = missing(env, SUPABASE_KEYS);
    if (absent.length > 0) {
      problems.push(`STORAGE_DRIVER=supabase требует: ${absent.join(', ')}`);
    }
  }

  const webpushAbsent = missing(env, WEBPUSH_KEYS);
  if (webpushAbsent.length > 0 && webpushAbsent.length < WEBPUSH_KEYS.length) {
    problems.push(`Web Push настраивается целиком, не хватает: ${webpushAbsent.join(', ')}`);
  }

  return problems;
}

export class EnvError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Некорректное окружение:\n- ${problems.join('\n- ')}`);
    this.name = 'EnvError';
  }
}

/**
 * В файлах .env незаданное значение записывается пустой строкой, а не отсутствует.
 * Иначе `DIRECT_DATABASE_URL=` считался бы заданным и не проходил проверку.
 */
function withoutEmptyValues(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, value === '' ? undefined : value]),
  );
}

/** Чистый разбор: принимает произвольный источник, чтобы его можно было проверить тестом. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(withoutEmptyValues(source));

  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`,
    );
    throw new EnvError(problems);
  }

  const problems = checkConditional(result.data);
  if (problems.length > 0) {
    throw new EnvError(problems);
  }

  return result.data;
}
