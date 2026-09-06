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

/** Порядок выбора повторяет drizzle.config.ts: пустая строка — это «не задано». */
const URL_VARIABLES = ['DIRECT_DATABASE_URL', 'DATABASE_URL'];

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
function resolveTarget() {
  const fromFile = dotenvValues();

  for (const variable of URL_VARIABLES) {
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

const target = resolveTarget();

if (target === null) {
  fail(
    'Отказ: не задан DATABASE_URL (или DIRECT_DATABASE_URL) — ни в окружении, ни в .env.\n' +
      'Команда к базе не запускается вслепую.',
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

const result = spawnSync(executable, rest, {
  stdio: 'inherit',
  // На Windows исполняемые файлы из node_modules/.bin — это .cmd,
  // а их Node без оболочки не запускает.
  shell: process.platform === 'win32',
});

if (result.error !== undefined) {
  fail(`Не удалось запустить «${executable}»: ${result.error.message}`);
}

process.exit(result.status ?? 1);
