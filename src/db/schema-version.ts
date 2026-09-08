import { sql } from 'drizzle-orm';

import { getDb, type Executor } from './client';
import { EXPECTED_MIGRATIONS, MIGRATIONS } from './migrations-manifest';

/**
 * Проверка версии схемы при старте (указание владельца, `docs/DEPLOY-VERCEL.md` §10).
 *
 * Приложение, поднятое на отставшей базе, ломается не сразу и не целиком:
 * половина запросов работает, половина падает на неизвестной колонке,
 * а человек видит случайные ошибки на случайных экранах. Понятный отказ
 * при первом же обращении к базе честнее (P7-16).
 */
export class SchemaOutdatedError extends Error {
  constructor(
    readonly applied: number,
    readonly expected: number,
  ) {
    super(
      `Схема базы отстала: применено миграций ${String(applied)}, код ждёт ${String(expected)}. ` +
        'Выполните `pnpm db:migrate` и перезапустите приложение.',
    );
    this.name = 'SchemaOutdatedError';
  }
}

/**
 * Что не так со схемой. Чистая функция: сравнение чисел проверяется
 * без базы, а поход в неё остаётся тонкой обёрткой.
 *
 * База впереди кода — не ошибка: так выглядит выкатка, где миграции
 * применены раньше, чем обновились экземпляры приложения. Обратное —
 * ошибка: код ждёт того, чего в базе нет.
 */
export function schemaProblem(applied: number, expected = EXPECTED_MIGRATIONS): string | null {
  if (applied >= expected) {
    return null;
  }

  return `применено ${String(applied)} из ${String(expected)}`;
}

/** Сколько миграций применено в базе. */
export async function appliedMigrations(executor: Executor = getDb()): Promise<number> {
  const rows = await executor.execute<{ count: number }>(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );

  const [row] = rows as unknown as { count: number }[];

  return row?.count ?? 0;
}

let checked: Promise<void> | null = null;

/**
 * Проверяет схему один раз на процесс.
 *
 * Один раз, а не на каждый запрос: миграции посреди работы процесса
 * не появляются, а лишний запрос к базе на каждое обращение стоил бы
 * дороже самой проверки.
 */
export function assertSchemaCurrent(executor?: Executor): Promise<void> {
  checked ??= (async () => {
    const applied = await appliedMigrations(executor);

    if (schemaProblem(applied) !== null) {
      throw new SchemaOutdatedError(applied, EXPECTED_MIGRATIONS);
    }
  })().catch((error: unknown) => {
    // Неудачную проверку не запоминаем: следующий запрос попробует снова.
    checked = null;

    throw error;
  });

  return checked;
}

export { EXPECTED_MIGRATIONS, MIGRATIONS };
