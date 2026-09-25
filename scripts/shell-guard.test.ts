import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Каждый скрипт оболочки в репозитории обязан начинаться с
 * `set -euo pipefail`.
 *
 * Последнее слово здесь главное. Дважды одно и то же: в фазе 1 коммит ушёл
 * при упавшем `pnpm verify`, потому что проверка стояла в конвейере и код
 * возврата взялся от `tail`; 24 сентября 2026 сборка образа падала, а
 * `docker compose build … | tail -1` показывал хвост, неотличимый
 * от успешного (разбор I19).
 *
 * Правило без проверки — не правило (CLAUDE.md §2), поэтому проверка
 * сканирует файлы, а не полагается на привычку.
 */
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

const REQUIRED = 'set -euo pipefail';

/** Где живут скрипты оболочки: каталог скриптов и каталог хуков. */
const PLACES = ['scripts', '.githooks'];

function shellFiles(): string[] {
  const found: string[] = [];

  for (const place of PLACES) {
    const directory = join(REPO_ROOT, place);

    for (const name of readdirSync(directory)) {
      const path = join(directory, name);

      if (!statSync(path).isFile()) {
        continue;
      }

      const isShell =
        name.endsWith('.sh') || readFileSync(path, 'utf8').startsWith('#!/usr/bin/env bash');

      if (isShell) {
        found.push(join(place, name));
      }
    }
  }

  return found;
}

describe('скрипты оболочки', () => {
  it('найдены: проверка не проходит на пустом списке', () => {
    expect(shellFiles().length).toBeGreaterThan(1);
  });

  it('каждый теряет ноль кодов возврата: set -euo pipefail на месте', () => {
    const offenders = shellFiles().filter(
      (path) => !readFileSync(join(REPO_ROOT, path), 'utf8').includes(REQUIRED),
    );

    expect(offenders).toEqual([]);
  });

  /*
   * Негативная фикстура: сам сканер обязан находить нарушение. Без неё
   * проверка осталась бы зелёной, даже если бы перестала что-либо читать.
   */
  it('сканер находит скрипт без pipefail', () => {
    const fixture = '#!/usr/bin/env bash\nset -e\necho привет\n';

    expect(fixture.includes(REQUIRED)).toBe(false);
  });

  /*
   * Развёртывание идёт скриптом, а не руками: скрипт сверяет хеш коммита
   * с тем, что отдаёт /api/health, и падает при несовпадении. Ровно этой
   * сверки не хватало 24 сентября.
   */
  it('скрипт развёртывания сверяет хеш и отказывается при расхождении', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/deploy.sh'), 'utf8');

    expect(source).toContain('git rev-parse HEAD');
    expect(source).toContain('APP_COMMIT');
    expect(source).toContain('--force-recreate');
    expect(source).toContain('а ожидался');
  });

  it('образ отдаёт версию наружу: /api/health содержит коммит', () => {
    const route = readFileSync(join(REPO_ROOT, 'src/app/api/health/route.ts'), 'utf8');
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const compose = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

    expect(route).toContain('APP_COMMIT');
    expect(dockerfile).toContain('ARG APP_COMMIT');
    expect(compose).toContain('APP_COMMIT');
  });
});
