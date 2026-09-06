import { spawnSync } from 'node:child_process';

/**
 * Ставит каталог хуков репозитория. Запускается из pnpm-скрипта prepare,
 * то есть при каждом `pnpm install`.
 *
 * Вне git-репозитория молча ничего не делает: сборка образа копирует
 * исходники без каталога .git, и падать там нечему.
 */
const isGitRepository = spawnSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });

if (isGitRepository.status !== 0) {
  process.exit(0);
}

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });

process.exit(result.status ?? 0);
