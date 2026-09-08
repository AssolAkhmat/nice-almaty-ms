import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * Негативные проверки стража подключения (CLAUDE.md §2 и §5).
 *
 * Инцидент, из которого страж родился: `DATABASE_URL` остался в окружении
 * оболочки, `drizzle-kit` взял его раньше `.env`, и миграция ушла в прод молча.
 * Поэтому проверяется не только запрет, но и то, что страж вслух называет
 * источник строки — окружение важнее файла, и человек должен это видеть.
 *
 * Команда для запуска берётся заведомо безобидная (`node --version`):
 * тест доказывает факт запуска, а не поведение drizzle-kit.
 */
const GUARD = join(import.meta.dirname, 'db-guard.mjs');
const REPO_ROOT = join(import.meta.dirname, '..');

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Пустой каталог: страж ищет `.env` рядом с собой, реальный файл репозитория не в счёт. */
function emptyDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'nice-dbguard-'));
  temporaryDirectories.push(directory);

  return directory;
}

interface RunOptions {
  /** Переменные окружения оболочки: `undefined` означает «переменной нет». */
  readonly shellEnv?: Readonly<Record<string, string | undefined>>;
  /** Содержимое файла `.env` в рабочем каталоге. */
  readonly dotenv?: string;
  /** Аргументы после имени команды. */
  readonly args?: readonly string[];
}

function runGuard(options: RunOptions = {}) {
  const directory = emptyDirectory();

  if (options.dotenv !== undefined) {
    writeFileSync(join(directory, '.env'), options.dotenv, 'utf8');
  }

  const environment: NodeJS.ProcessEnv = { ...process.env };

  // Собственные переменные машины не должны просачиваться в тест.
  delete environment.DATABASE_URL;
  delete environment.DIRECT_DATABASE_URL;

  for (const [key, value] of Object.entries(options.shellEnv ?? {})) {
    if (value === undefined) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }

  const result = spawnSync(
    process.execPath,
    [GUARD, 'node', '--version', ...(options.args ?? [])],
    { cwd: directory, encoding: 'utf8', env: environment },
  );

  return { ...result, output: `${result.stdout}${result.stderr}` };
}

/** Признак того, что обёрнутая команда действительно выполнилась. */
function commandRan(result: { stdout: string }): boolean {
  return /v\d+\.\d+\.\d+/.test(result.stdout);
}

const LOCAL = 'postgres://nice:nice@localhost:5432/nice_almaty';
const REMOTE = 'postgres://postgres:s3cret-parol@db.abcdef.supabase.co:5432/postgres';

describe('страж подключения перед db:*', () => {
  it('пропускает команду на локальную базу', () => {
    const result = runGuard({ shellEnv: { DATABASE_URL: LOCAL } });

    expect(result.status).toBe(0);
    expect(commandRan(result)).toBe(true);
  });

  it('останавливается на нелокальном хосте и не запускает команду', () => {
    const result = runGuard({ shellEnv: { DATABASE_URL: REMOTE } });

    expect(result.status).not.toBe(0);
    expect(commandRan(result)).toBe(false);
    expect(result.stderr).toContain('db.abcdef.supabase.co');
  });

  it('печатает хост назначения до запуска, а не после', () => {
    const result = runGuard({ shellEnv: { DATABASE_URL: LOCAL } });

    const host = result.stdout.indexOf('localhost');
    const version = result.stdout.search(/v\d+\.\d+\.\d+/);

    expect(host).toBeGreaterThanOrEqual(0);
    expect(version).toBeGreaterThan(host);
  });

  it('подсказывает, как подтвердить нелокальную цель', () => {
    const result = runGuard({ shellEnv: { DATABASE_URL: REMOTE } });

    expect(result.stderr).toContain('--allow-remote=db.abcdef.supabase.co');
  });

  it('пропускает нелокальную цель при явном подтверждении в команде', () => {
    const result = runGuard({
      shellEnv: { DATABASE_URL: REMOTE },
      args: ['--allow-remote=db.abcdef.supabase.co'],
    });

    expect(result.status).toBe(0);
    expect(commandRan(result)).toBe(true);
  });

  it('не пробрасывает собственный флаг в обёрнутую команду', () => {
    const result = runGuard({
      shellEnv: { DATABASE_URL: REMOTE },
      args: ['--allow-remote=db.abcdef.supabase.co'],
    });

    // Строка «Выполняю: …» — то, что страж реально передаёт дальше.
    const executed = /Выполняю: (.*)/.exec(result.stdout)?.[1] ?? '';

    expect(executed).toContain('node --version');
    expect(executed).not.toContain('allow-remote');
  });

  it('не принимает подтверждение с чужим хостом: забытый в алиасе флаг не работает', () => {
    const result = runGuard({
      shellEnv: { DATABASE_URL: REMOTE },
      args: ['--allow-remote=db.staging.supabase.co'],
    });

    expect(result.status).not.toBe(0);
    expect(commandRan(result)).toBe(false);
  });

  it('подтверждение без хоста не считается подтверждением', () => {
    const result = runGuard({ shellEnv: { DATABASE_URL: REMOTE }, args: ['--allow-remote'] });

    expect(result.status).not.toBe(0);
    expect(commandRan(result)).toBe(false);
  });
});

describe('страж называет источник строки подключения', () => {
  it('окружение оболочки: ровно тот случай, из-за которого миграция ушла в прод', () => {
    const result = runGuard({
      shellEnv: { DATABASE_URL: LOCAL },
      dotenv: `DATABASE_URL=${LOCAL}\n`,
    });

    expect(result.stdout).toContain('окружени');
    expect(result.stdout).not.toContain('.env');
  });

  it('файл .env, когда в оболочке переменной нет', () => {
    const result = runGuard({ dotenv: `DATABASE_URL=${LOCAL}\n` });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.env');
  });

  it('окружение оболочки перебивает .env, и цель берётся оттуда', () => {
    const result = runGuard({
      shellEnv: { DATABASE_URL: REMOTE },
      dotenv: `DATABASE_URL=${LOCAL}\n`,
    });

    // Локальный .env не должен усыплять: цель — прод из оболочки.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('db.abcdef.supabase.co');
  });
});

describe('страж повторяет выбор строки за drizzle.config.ts', () => {
  it('DIRECT_DATABASE_URL важнее DATABASE_URL — там, где его читает сама команда', () => {
    // Порядок остался прежним для drizzle-kit: он и читает эту переменную.
    const output = runGuardNaming(['drizzle-kit', 'migrate'], {
      DATABASE_URL: LOCAL,
      DIRECT_DATABASE_URL: REMOTE,
    });

    expect(output).toContain('DIRECT_DATABASE_URL');
    expect(output).toContain('Отказ');
  });

  it('пустой DIRECT_DATABASE_URL — не заданный: так его гасит docker-compose', () => {
    const result = runGuard({
      shellEnv: { DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: '' },
    });

    expect(result.status).toBe(0);
    expect(commandRan(result)).toBe(true);
  });

  it('без строки подключения команда не запускается', () => {
    const result = runGuard();

    expect(result.status).not.toBe(0);
    expect(commandRan(result)).toBe(false);
    expect(result.stderr).toContain('DATABASE_URL');
  });

  it('нечитаемая строка подключения не пропускается «на всякий случай»', () => {
    const result = runGuard({ shellEnv: { DATABASE_URL: 'не-адрес-вовсе' } });

    expect(result.status).not.toBe(0);
    expect(commandRan(result)).toBe(false);
  });
});

describe('страж не печатает секреты', () => {
  it('пароль из строки подключения не попадает в вывод', () => {
    const result = runGuard({ shellEnv: { DATABASE_URL: REMOTE } });

    expect(result.output).not.toContain('s3cret-parol');
  });

  it('пароль не печатается и на разрешённом прогоне', () => {
    const result = runGuard({
      shellEnv: { DATABASE_URL: REMOTE },
      args: ['--allow-remote=db.abcdef.supabase.co'],
    });

    expect(result.output).not.toContain('s3cret-parol');
  });
});

describe('все команды db:* закрыты стражем', () => {
  it('ни один скрипт db:* не идёт мимо db-guard.mjs', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const scripts = (manifest as { scripts: Record<string, string> }).scripts;

    const unguarded = Object.entries(scripts)
      .filter(([name]) => name.startsWith('db:'))
      .filter(([, command]) => !command.includes('db-guard.mjs'))
      .map(([name]) => name);

    expect(unguarded).toEqual([]);
  });

  it('список команд db:* не опустел: проверка сама себя не обманывает', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const scripts = (manifest as { scripts: Record<string, string> }).scripts;

    expect(Object.keys(scripts).filter((name) => name.startsWith('db:')).length).toBeGreaterThan(0);
  });
});

/**
 * Окружение для обёрнутой команды.
 *
 * `tsx` и `drizzle-kit` сами `.env` не читают: `pnpm db:seed` падал на разборе
 * окружения, требуя DEPLOY_TARGET, APP_URL и остальные секреты, хотя рядом
 * лежал заполненный файл. Страж этот файл уже читает — ради выбора цели, —
 * поэтому он же и передаёт его вниз. Порядок тот же, что и у цели:
 * значение из оболочки сильнее файла.
 */
function runGuardPrinting(
  variable: string,
  options: { dotenv: string; shellEnv?: Readonly<Record<string, string | undefined>> },
) {
  const directory = emptyDirectory();
  writeFileSync(join(directory, '.env'), options.dotenv, 'utf8');

  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.DATABASE_URL;
  delete environment.DIRECT_DATABASE_URL;

  for (const [key, value] of Object.entries(options.shellEnv ?? {})) {
    if (value === undefined) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }

  return spawnSync(
    process.execPath,
    [GUARD, process.execPath, '-p', `process.env.${variable} ?? 'НЕТ'`],
    { cwd: directory, encoding: 'utf8', env: environment },
  );
}

describe('окружение команды', () => {
  const LOCAL = 'DATABASE_URL=postgres://nice:nice@localhost:5432/nice\n';

  it('переменная из .env доходит до запущенной команды', () => {
    const result = runGuardPrinting('SESSION_SECRET', {
      dotenv: `${LOCAL}SESSION_SECRET=из-файла\n`,
    });

    expect(result.stdout).toContain('из-файла');
  });

  it('значение из оболочки сильнее файла', () => {
    const result = runGuardPrinting('SESSION_SECRET', {
      dotenv: `${LOCAL}SESSION_SECRET=из-файла\n`,
      shellEnv: { SESSION_SECRET: 'из-оболочки' },
    });

    expect(result.stdout).toContain('из-оболочки');
    expect(result.stdout).not.toContain('из-файла');
  });

  it('пустое значение в файле значением не считается', () => {
    const result = runGuardPrinting('SESSION_SECRET', { dotenv: `${LOCAL}SESSION_SECRET=\n` });

    expect(result.stdout).toContain('НЕТ');
  });
});

/**
 * Цель зависит от того, что именно оборачивают.
 *
 * `drizzle-kit` читает `DIRECT_DATABASE_URL` и только потом `DATABASE_URL`,
 * а приложение (`tsx src/db/seed.cli.ts`) знает единственную переменную —
 * `DATABASE_URL`. Пока страж выбирал по одному правилу для обеих команд,
 * он называл сиду чужой хост: подтверждали Supabase, а писало в локальную базу.
 */
function runGuardNaming(
  command: readonly string[],
  shellEnv: Readonly<Record<string, string | undefined>>,
) {
  const directory = emptyDirectory();

  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.DATABASE_URL;
  delete environment.DIRECT_DATABASE_URL;

  for (const [key, value] of Object.entries(shellEnv)) {
    if (value === undefined) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }

  const result = spawnSync(process.execPath, [GUARD, ...command], {
    cwd: directory,
    encoding: 'utf8',
    env: environment,
  });

  return `${result.stdout}${result.stderr}`;
}

describe('выбор переменной по команде', () => {
  const DIRECT = 'postgres://user:pass@direct.example.com:5432/db';
  const POOLER = 'postgres://user:pass@pooler.example.com:6543/db';

  it('drizzle-kit идёт по DIRECT_DATABASE_URL', () => {
    const output = runGuardNaming(['drizzle-kit', 'migrate'], {
      DIRECT_DATABASE_URL: DIRECT,
      DATABASE_URL: POOLER,
    });

    expect(output).toContain('direct.example.com');
    expect(output).toContain('Источник: DIRECT_DATABASE_URL');
  });

  it('приложение идёт по DATABASE_URL, даже когда задан DIRECT', () => {
    const output = runGuardNaming(['tsx', 'src/db/seed.cli.ts'], {
      DIRECT_DATABASE_URL: DIRECT,
      DATABASE_URL: POOLER,
    });

    expect(output).toContain('pooler.example.com');
    expect(output).toContain('Источник: DATABASE_URL');
    expect(output).not.toContain('direct.example.com');
  });
});
