import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `scripts/ci-status.sh` обязан называть причину, а не факт недоступности
 * (CLAUDE.md §2, «правило увиденного отказа»).
 *
 * Сообщение «состояние недоступно (лимит запросов или сеть)» стояло на всех
 * случаях сразу, и 28 сентября 2026 оно увело искать сетевой сбой там, где
 * надо было сделать `git push`: незапушенный коммит GitHub отдаёт как 422.
 *
 * Проверка подменяет `curl` заглушкой на PATH и смотрит, что скрипт говорит
 * при каждом ответе. Без этого теста сообщение снова сползёт в одно на всё:
 * такое уже было.
 */
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

/**
 * Заглушка `curl`: на запрос здоровья отдаёт чужой коммит, на запрос
 * GitHub — заданный код ответа. Различаются запросы по адресу в аргументах.
 */
function runWith(httpStatus: string, body = '{"check_runs":[]}'): string {
  const bin = mkdtempSync(join(tmpdir(), 'ci-status-'));
  const stub = join(bin, 'curl');

  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'args="$*"',
      'out=""',
      '',
      '# Разбираем только то, что нужно скрипту: -o <файл> и адрес.',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      '',
      'case "${args}" in',
      '  *api/health*)',
      '    printf \'{"commit":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}\'',
      '    exit 0',
      '    ;;',
      '  *check-runs*)',
      `    if [ -n "\${out}" ]; then printf '%s' '${body}' > "\${out}"; fi`,
      `    printf '%s' '${httpStatus}'`,
      '    exit 0',
      '    ;;',
      'esac',
      'exit 1',
    ].join('\n'),
    'utf8',
  );
  chmodSync(stub, 0o755);

  return execFileSync('bash', [join(REPO_ROOT, 'scripts', 'ci-status.sh'), 'a'.repeat(40)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
}

describe('состояние CI', () => {
  it('незапушенный коммит назван незапушенным, а не сетевым сбоем', () => {
    const output = runWith('422');

    expect(output).toContain('не запушен');
    expect(output).not.toContain('сеть');
  });

  it('исчерпанный лимит назван лимитом', () => {
    expect(runWith('403')).toContain('лимит запросов');
  });

  it('недоступная сеть названа сетью', () => {
    expect(runWith('000')).toContain('сеть недоступна');
  });

  it('при успешном ответе без прогонов так и сказано', () => {
    expect(runWith('200')).toContain('ещё не запускался');
  });

  it('прогон с результатом печатается построчно', () => {
    const body = '{"check_runs":[{"name":"verify","conclusion":"success"}]}';

    expect(runWith('200', body)).toContain('verify — success');
  });

  /* Коммит, которого нет на сервере, «зелёным CI» ничего не подтверждает. */
  it('несовпадение с боевой версией называется прямо', () => {
    expect(runWith('422')).toContain('ДРУГОЙ');
  });
});
