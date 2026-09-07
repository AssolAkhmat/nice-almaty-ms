import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Список миграций, известных коду (указание владельца из `OWNER-NOTES.md`).
 *
 * Папку с миграциями приложение во время работы не видит: в standalone-сборке
 * её рядом нет, а на Vercel файловая система своя. Поэтому список кладётся
 * в исходник и уезжает вместе со сборкой — по нему приложение и понимает,
 * что схема в базе отстала.
 *
 * Запуск: `node scripts/write-migrations-manifest.mjs` (входит в `db:generate`).
 */
const directory = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const target = fileURLToPath(new URL('../src/db/migrations-manifest.ts', import.meta.url));

const names = readdirSync(directory)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const body = `/*
 * Список миграций, известных этой сборке. Файл создаётся скриптом
 * \`scripts/write-migrations-manifest.mjs\` и обновляется вместе с новой
 * миграцией: руками его не правят.
 *
 * Он нужен проверке версии схемы при старте: приложение сравнивает свой
 * список с тем, что применено в базе, и падает понятной ошибкой, если
 * миграции забыли накатить.
 */
export const MIGRATIONS = [
${names.map((name) => `  '${name}',`).join('\n')}
] as const;

export const EXPECTED_MIGRATIONS = MIGRATIONS.length;
`;

writeFileSync(target, body, 'utf8');
process.stdout.write(`migrations-manifest.ts: ${String(names.length)} миграций\n`);
