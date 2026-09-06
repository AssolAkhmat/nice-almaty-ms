import 'server-only';

import { loadEnv } from '@/lib/env/load';

/**
 * Единственная точка чтения process.env в серверном коде приложения
 * (CLAUDE.md §5). Некорректное окружение роняет процесс сразу,
 * а не в середине запроса.
 */
export const env = loadEnv();

export type { Env } from '@/lib/env/schema';
