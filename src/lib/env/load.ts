import { parseEnv, type Env } from './schema';

let cached: Env | null = null;

/**
 * Разбор окружения с запоминанием результата.
 * Отдельно от `src/env.ts`, потому что тот помечен `server-only`,
 * а воркер и миграции исполняются обычным Node-процессом.
 */
export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
