import { defineConfig } from 'drizzle-kit';

/**
 * Миграции идут прямым подключением: на Supabase пулер (порт 6543)
 * не поддерживает DDL в режиме transaction pooling.
 * Если DIRECT_DATABASE_URL не задан, используется DATABASE_URL.
 */
const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;

if (url === undefined || url === '') {
  throw new Error('Не задан DATABASE_URL (или DIRECT_DATABASE_URL) для drizzle-kit');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
