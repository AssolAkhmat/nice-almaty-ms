import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Каждый список из репозитория обязан иметь устойчивый порядок.
 *
 * Строки, записанные одной транзакцией, получают от `now()` одно и то же
 * время: сортировка по `created_at` перестаёт их различать, и порядок
 * остаётся на усмотрение планировщика. Так уже ломались список аккаунтов
 * (инцидент I5) и раздача генеральной уборки — молча, в CI, на одной
 * из трёх ширин.
 *
 * Правило простое и проверяемое: последний ключ сортировки —
 * идентификатор строки. Он уникален всегда, и порядок перестаёт зависеть
 * от плана запроса. Правило без такой проверки — не правило (CLAUDE.md §2).
 */
const DIRECTORY = new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

function sourceFiles(): string[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.includes('.test.') && !name.includes('.db-test.'))
    .filter((name) => name !== 'index.ts');
}

/** Содержимое каждого вызова `.orderBy(...)`: скобки внутри учитываются. */
function orderByClauses(source: string): string[] {
  const clauses: string[] = [];
  const marker = '.orderBy(';
  let cursor = source.indexOf(marker);

  while (cursor !== -1) {
    const start = cursor + marker.length;
    let depth = 1;
    let index = start;

    while (index < source.length && depth > 0) {
      const char = source[index];

      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }

      index += 1;
    }

    clauses.push(source.slice(start, index - 1));
    cursor = source.indexOf(marker, index);
  }

  return clauses;
}

/**
 * Последний аргумент верхнего уровня: запятые внутри вложенных скобок
 * не в счёт, висячая запятая в конце — тоже (её ставит prettier).
 */
function lastArgument(clause: string): string {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < clause.length; index += 1) {
    const char = clause[index];

    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(clause.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(clause.slice(start));

  const meaningful = parts.map((part) => part.trim()).filter((part) => part !== '');

  return meaningful.at(-1) ?? '';
}

describe('устойчивый порядок списков', () => {
  it('каждая сортировка в репозиториях кончается идентификатором', () => {
    const unstable: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(join(DIRECTORY, file), 'utf8');

      for (const clause of orderByClauses(source)) {
        const last = lastArgument(clause);

        if (!/\.id\b/.test(last)) {
          unstable.push(`${file}: ${clause.replace(/\s+/g, ' ').trim()}`);
        }
      }
    }

    expect(unstable, `сортировка без уникального ключа:\n${unstable.join('\n')}`).toEqual([]);
  });

  it('сама проверка ловит сортировку без уникального ключа', () => {
    const fixture = `
      executor.select().from(invoices).orderBy(desc(invoices.createdAt));
    `;

    const [clause] = orderByClauses(fixture);

    expect(clause).toBeDefined();
    expect(/\.id\b/.test(lastArgument(clause ?? ''))).toBe(false);
  });

  it('многострочная сортировка разбирается целиком', () => {
    const fixture = `
      .orderBy(
        asc(rotationAssignments.slotPosition),
        asc(rotationAssignments.createdAt),
        asc(rotationAssignments.id),
      );
    `;

    const [clause] = orderByClauses(fixture);

    expect(lastArgument(clause ?? '')).toBe('asc(rotationAssignments.id)');
  });
});
