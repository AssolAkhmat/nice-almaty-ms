import 'server-only';

import { parseEnv } from '@/lib/env/schema';

/**
 * Единственная точка чтения process.env (CLAUDE.md §5).
 * Разбор происходит при первом импорте: некорректное окружение
 * должно ронять приложение сразу, а не в середине запроса.
 */
export const env = parseEnv(process.env);

export type { Env } from '@/lib/env/schema';
