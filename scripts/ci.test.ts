import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож конвейера (CLAUDE.md §2).
 *
 * `pnpm test:db` существовал с фазы 1, был описан в `docs/08-DECISIONS.md`
 * как «в CI выполняется в job с сервисом postgres» — и не выполнялся нигде.
 * Восемьдесят четыре интеграционных теста, включая изоляцию домов и матрицу
 * прав, ни разу не проверялись на сервере: заявленная проверка отсутствовала,
 * и заметить это было неоткуда.
 *
 * Отсюда правило: команда вида `test:*` обязана иметь шаг в конвейере.
 * Новый вид тестов без шага роняет этот тест.
 */
const REPO_ROOT = join(import.meta.dirname, '..');

/** Интерактивный наблюдатель: в конвейере ему делать нечего. */
const INTERACTIVE = new Set(['test:watch']);

function scripts(): Record<string, string> {
  const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

  return (manifest as { scripts: Record<string, string> }).scripts;
}

function workflow(): string {
  return readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
}

/**
 * Запуск именно этой команды, а не той, чьё имя начинается так же:
 * `pnpm test` — не доказательство того, что выполняется `pnpm test:db`.
 */
function runsInPipeline(pipeline: string, script: string): boolean {
  return new RegExp(String.raw`pnpm ${script}(?![\w:-])`).test(pipeline);
}

/** Тестовые команды, обязанные выполняться в конвейере. */
function requiredScripts(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith('test') && !INTERACTIVE.has(name));
}

/**
 * Команды, до которых конвейер добирается: прямо шагом или через другой
 * запущенный скрипт. `pnpm test` шага не имеет — его выполняет `pnpm verify`.
 */
function reachedByPipeline(
  definitions: Readonly<Record<string, string>>,
  pipeline: string,
): Set<string> {
  const reached = new Set(
    Object.keys(definitions).filter((name) => runsInPipeline(pipeline, name)),
  );

  let growing = true;

  while (growing) {
    growing = false;

    for (const [name, body] of Object.entries(definitions)) {
      if (!reached.has(name)) {
        continue;
      }

      for (const candidate of Object.keys(definitions)) {
        if (!reached.has(candidate) && runsInPipeline(body, candidate)) {
          reached.add(candidate);
          growing = true;
        }
      }
    }
  }

  return reached;
}

function missingFromPipeline(
  definitions: Readonly<Record<string, string>>,
  pipeline: string,
): string[] {
  const reached = reachedByPipeline(definitions, pipeline);

  return requiredScripts(Object.keys(definitions)).filter((script) => !reached.has(script));
}

describe('конвейер запускает все проверки', () => {
  it('каждая команда test:* выполняется в CI', () => {
    expect(missingFromPipeline(scripts(), workflow())).toEqual([]);
  });

  it('интеграционные тесты идут после миграций: до них схемы нет', () => {
    const pipeline = workflow();

    expect(pipeline.indexOf('pnpm db:migrate')).toBeLessThan(pipeline.indexOf('pnpm test:db'));
  });

  it('pnpm verify стоит в конвейере', () => {
    expect(runsInPipeline(workflow(), 'verify')).toBe(true);
  });

  it('список обязательных команд не опустел: проверка сама себя не обманывает', () => {
    expect(requiredScripts(Object.keys(scripts()))).toContain('test:db');
  });

  it('юнит-тесты засчитываются через verify, а не требуют своего шага', () => {
    expect(reachedByPipeline(scripts(), workflow())).toContain('test');
  });
});

describe('сторож срабатывает', () => {
  it('видит пропавший из конвейера прогон — ровно тот дефект, что был', () => {
    const withoutIntegration = workflow().replace(/pnpm test:db/g, 'pnpm build');

    expect(missingFromPipeline(scripts(), withoutIntegration)).toContain('test:db');
  });

  it('не принимает `pnpm test` за `pnpm test:db`', () => {
    expect(runsInPipeline('run: pnpm test\n', 'test:db')).toBe(false);
  });

  it('не принимает упоминание в комментарии за шаг: нужна команда', () => {
    expect(runsInPipeline('# когда-нибудь добавить test:db\n', 'test:db')).toBe(false);
  });
});
