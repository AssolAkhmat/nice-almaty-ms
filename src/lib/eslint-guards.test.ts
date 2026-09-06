import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Защитные правила ESLint проверяются негативными фикстурами (CLAUDE.md §2).
 * В фазе 0 запрет прямого `new Date()` полтора коммита раскрывался из
 * несуществующего поля объекта и молча не применялся. Правило, срабатывание
 * которого никто не проверяет, — это не правило.
 *
 * Тест линтует настоящим конфигом проекта, а не упрощённой копией.
 */
const lint = new ESLint({ ignore: false });

async function ruleIdsFor(file: string): Promise<string[]> {
  const [result] = await lint.lintFiles([file]);

  return (result?.messages ?? [])
    .map((message) => message.ruleId)
    .filter((ruleId): ruleId is string => ruleId !== null);
}

describe('запрет прямого обращения к системным часам', () => {
  it('срабатывает на new Date() и на Date.now()', async () => {
    const ruleIds = await ruleIdsFor('src/lib/__fixtures__/raw-date.fixture.ts');

    expect(ruleIds.filter((ruleId) => ruleId === 'no-restricted-syntax')).toHaveLength(2);
  }, 60_000);

  it('не срабатывает в src/lib/time.ts — единственном разрешённом месте', async () => {
    const ruleIds = await ruleIdsFor('src/lib/time.ts');

    expect(ruleIds).not.toContain('no-restricted-syntax');
  }, 60_000);
});

describe('запрет зависимостей расчётных ядер', () => {
  it('срабатывает на импорт базы данных из src/domain', async () => {
    const ruleIds = await ruleIdsFor('src/domain/__fixtures__/forbidden-import.fixture.ts');

    expect(ruleIds).toContain('no-restricted-imports');
  }, 60_000);

  it('не срабатывает на чистое ядро', async () => {
    const ruleIds = await ruleIdsFor('src/domain/money.ts');

    expect(ruleIds).toEqual([]);
  }, 60_000);
});
