import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * Негативная проверка хука (CLAUDE.md §2): защита без доказательства
 * срабатывания не существует.
 *
 * Настоящий `pnpm verify` тут запускать нельзя — этот тест сам его часть,
 * получилась бы рекурсия. Поэтому в PATH подставляется поддельный `pnpm`
 * с нужным кодом возврата: проверяется ровно то, что однажды сломалось —
 * доходит ли ненулевой код до самого хука.
 */
const HOOK = join(import.meta.dirname, '..', '.githooks', 'pre-push');
const REPO_ROOT = join(import.meta.dirname, '..');

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Каталог с подложным `pnpm`, который завершается заданным кодом. */
function fakePnpmDirectory(exitCode: number): string {
  const directory = mkdtempSync(join(tmpdir(), 'nice-hook-'));
  temporaryDirectories.push(directory);

  writeFileSync(
    join(directory, 'pnpm'),
    `#!/usr/bin/env bash\necho "поддельный pnpm: $*"\nexit ${String(exitCode)}\n`,
    'utf8',
  );
  chmodSync(join(directory, 'pnpm'), 0o755);

  return directory;
}

function runHook(exitCode: number) {
  const directory = fakePnpmDirectory(exitCode);

  return spawnSync('bash', [HOOK], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
  });
}

describe('хук pre-push', () => {
  it('пропускает отправку, когда проверки прошли', () => {
    const result = runHook(0);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('проверки пройдены');
  });

  it('блокирует отправку, когда проверки упали', () => {
    const result = runHook(1);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('отправка отменена');
  });

  it('доносит наружу именно ненулевой код, а не код последней команды', () => {
    // Ровно тот дефект, из-за которого коммит однажды ушёл при красном verify.
    expect(runHook(2).status).not.toBe(0);
    expect(runHook(127).status).not.toBe(0);
  });

  it('исполняется с pipefail: код возврата берётся от упавшей команды конвейера', () => {
    const source = readFileSync(HOOK, 'utf8');

    expect(source).toContain('set -euo pipefail');
  });

  it('подсказывает осознанный обход, а не молчит', () => {
    expect(runHook(1).stderr).toContain('--no-verify');
  });
});

describe('установка хуков', () => {
  it('прописывает каталог хуков репозитория', () => {
    const install = spawnSync('node', ['scripts/install-hooks.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(install.status).toBe(0);

    const configured = spawnSync('git', ['config', 'core.hooksPath'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(configured.stdout.trim()).toBe('.githooks');
  });

  it('вне git-репозитория молча ничего не делает: сборка образа идёт без .git', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nice-nogit-'));
    temporaryDirectories.push(directory);

    const install = spawnSync('node', [join(REPO_ROOT, 'scripts', 'install-hooks.mjs')], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(install.status).toBe(0);
  });
});
