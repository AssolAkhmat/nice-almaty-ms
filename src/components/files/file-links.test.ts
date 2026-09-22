import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fileViewHref } from './file-links';

/**
 * Ссылка на документ собирается в одном месте (указание владельца,
 * 22 сентября 2026). Прямой адрес содержимого, вписанный в разметку мимо
 * `fileViewHref`, работал бы без пропуска и жил бы вечно — ровно то, от чего
 * пропуск и заведён.
 *
 * Проверка сканирует исходники, а не намерения: новая ссылка на `/content`
 * в любом экране роняет прогон.
 */
const UI_ROOTS = ['src/app/(app)', 'src/components'];

/** Сам маршрут отдачи и его тесты — единственные, кому адрес знать положено. */
const ALLOWED = [
  join('src', 'app', 'api'),
  join('src', 'components', 'files', 'file-links.test.ts'),
];

function walk(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      found.push(...walk(path));
      continue;
    }

    if (path.endsWith('.ts') || path.endsWith('.tsx')) {
      found.push(path);
    }
  }

  return found;
}

describe('ссылки на содержимое файла', () => {
  it('открывают через /view, а не напрямую', () => {
    expect(fileViewHref('abc')).toBe('/api/v1/files/abc/view');
    expect(fileViewHref('abc', true)).toBe('/api/v1/files/abc/view?download=1');
  });

  it('прямого адреса содержимого нет ни в одном экране', () => {
    const direct = /\/api\/v1\/files\/[^'"`\n]*\/content/;

    const offenders = UI_ROOTS.flatMap(walk)
      .filter((path) => !ALLOWED.some((allowed) => path.includes(allowed)))
      .filter((path) => direct.test(readFileSync(path, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
