import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Страж подключения перед любой командой `db:*` (CLAUDE.md §5).
 *
 * Инцидент: `DATABASE_URL` остался в окружении оболочки, `drizzle-kit` взял его
 * раньше `.env` — и миграция ушла в прод. Ошибка была тихой, потому что
 * ни одна команда не называла хост, к которому подключается.
 *
 * Отсюда два правила. Первое: перед запуском печатается цель и то, откуда взята
 * строка — из оболочки или из файла. Второе: нелокальный хост останавливает
 * команду, пока в ней самой не стоит `--allow-remote=<хост>` с тем же именем.
 * Совпадение имени обязательно: флаг, забытый в алиасе, не должен разрешать
 * следующую, уже другую цель.
 *
 * Использование: node scripts/db-guard.mjs <команда> [аргументы...]
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const CONFIRMATION = '--allow-remote';

/**
 * Какую переменную читает обёрнутая команда.
 *
 * `drizzle-kit` повторяет `drizzle.config.ts`: сперва `DIRECT_DATABASE_URL`,
 * потом `DATABASE_URL`. Приложение (`tsx src/db/seed.cli.ts`) знает только
 * `DATABASE_URL` — `src/db/client.ts`. Пока правило было общим, страж называл
 * сиду хост из `DIRECT_DATABASE_URL`, а писал сид в другую базу: подтверждали
 * одно, менялось другое.
 */
const MIGRATION_TOOL = 'drizzle-kit';

function urlVariablesFor(executable) {
  const tool = executable.split(/[\\/]/).pop() ?? executable;

  return tool.startsWith(MIGRATION_TOOL)
    ? ['DIRECT_DATABASE_URL', 'DATABASE_URL']
    : ['DATABASE_URL'];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Значения `.env` рабочего каталога. Файла может не быть — в контейнере
 * и в CI переменные приходят только из окружения.
 */
function dotenvValues() {
  try {
    return parseEnv(readFileSync(join(process.cwd(), '.env'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Строка подключения и её происхождение — ровно так, как их увидит drizzle-kit:
 * окружение оболочки перекрывает файл, а не наоборот.
 */
function resolveTarget(variables) {
  const fromFile = dotenvValues();

  for (const variable of variables) {
    const shell = process.env[variable];
    const fromShell = shell !== undefined;
    const value = fromShell ? shell : (fromFile[variable] ?? '');

    if (value !== '') {
      return { variable, value, source: fromShell ? 'окружение оболочки' : 'файл .env' };
    }
  }

  return null;
}

const rawArguments = process.argv.slice(2);
const allowed = rawArguments
  .filter((argument) => argument.startsWith(`${CONFIRMATION}=`))
  .map((argument) => argument.slice(CONFIRMATION.length + 1));

const command = rawArguments.filter(
  (argument) => argument !== CONFIRMATION && !argument.startsWith(`${CONFIRMATION}=`),
);

if (command.length === 0) {
  fail(`Нечего выполнять: node scripts/db-guard.mjs <команда> [${CONFIRMATION}=<хост>]`);
}

const variables = urlVariablesFor(command[0] ?? '');
const target = resolveTarget(variables);

if (target === null) {
  fail(
    `Отказ: не задан ${variables.join(' (или ')}${variables.length > 1 ? ')' : ''} — ` +
      'ни в окружении, ни в .env.\nКоманда к базе не запускается вслепую.',
  );
}

let parsed;

try {
  parsed = new URL(target.value);
} catch {
  fail(
    `Отказ: строку подключения из ${target.variable} не удалось разобрать как адрес.\n` +
      'Пропустить непонятную цель нельзя: неизвестно, куда пойдёт команда.',
  );
}

const host = parsed.hostname;
const port = parsed.port === '' ? '5432' : parsed.port;
const database = parsed.pathname.replace(/^\//, '');

// Пароль сюда не попадает намеренно: вывод команды уходит в логи и в CI.
console.log(`Цель: ${host}:${port}/${database}`);
console.log(`Источник: ${target.variable} — ${target.source}`);

if (!LOCAL_HOSTS.has(host)) {
  if (!allowed.includes(host)) {
    fail(
      `Отказ: хост «${host}» не локальный, а команда меняет базу.\n` +
        `Строка взята из ${target.variable} — ${target.source}.\n` +
        `Если это намеренно, повтори команду с ${CONFIRMATION}=${host}`,
    );
  }

  console.log(`Нелокальная цель подтверждена в команде: ${CONFIRMATION}=${host}`);
}

console.log(`Выполняю: ${command.join(' ')}`);

const [executable, ...rest] = command;

/**
 * Окружение для обёрнутой команды: значения из `.env`, поверх — окружение
 * оболочки. Ни `tsx`, ни `drizzle-kit` файл сами не читают, и `pnpm db:seed`
 * падал на разборе окружения рядом с заполненным `.env`. Страж этот файл уже
 * прочитал, выбирая цель, — он же и передаёт его вниз, тем же порядком:
 * заданное в оболочке сильнее файла, пустое значение значением не считается.
 */
function childEnvironment() {
  const fromFile = Object.fromEntries(
    Object.entries(dotenvValues()).filter(([, value]) => value !== ''),
  );

  return { ...fromFile, ...process.env };
}

const result = spawnSync(executable, rest, {
  stdio: 'inherit',
  env: childEnvironment(),
  // На Windows исполняемые файлы из node_modules/.bin — это .cmd,
  // а их Node без оболочки не запускает.
  shell: process.platform === 'win32',
});

if (result.error !== undefined) {
  fail(`Не удалось запустить «${executable}»: ${result.error.message}`);
}

process.exit(result.status ?? 1);
