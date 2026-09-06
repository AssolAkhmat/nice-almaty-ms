import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Маркер заблокированного таска (CLAUDE.md §8).
 *
 * Внешний цикл читает `docs/BLOCKED.md` сырыми строками и останавливается,
 * найдя заголовок с идентификатором таска. Разметку он не разбирает: блок кода
 * его не спасает, и однажды это уже сработало — образец записи внутри
 * ```-фенса останавливал цикл на пустом файле.
 *
 * Отсюда правило: пример держится в CLAUDE.md, а в BLOCKED.md формат описан
 * прозой. Здесь это правило проверяется, а не декларируется.
 */
const REPO_ROOT = join(import.meta.dirname, '..');

/**
 * Тот же шаблон, что у внешнего цикла. Собирается заново на каждое обращение:
 * общий регэксп с флагом `g` помнит позицию между вызовами `test`,
 * и проверка начала бы через раз врать.
 */
const RECORD_SOURCE = String.raw`^##\s+T\d+\.\d+`;

function recordPattern(flags: string): RegExp {
  return new RegExp(RECORD_SOURCE, flags);
}

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

function blockedRecords(): string[] {
  return read('docs/BLOCKED.md').match(recordPattern('gm')) ?? [];
}

/** Строка «Заблокировано» из шапки PROGRESS.md. */
function progressSaysNothingBlocked(): boolean {
  const line = /\*\*Заблокировано:\*\*(.*)/.exec(read('PROGRESS.md'))?.[1] ?? '';

  return /ничего/i.test(line);
}

describe('маркер заблокированного таска', () => {
  it('BLOCKED.md и PROGRESS.md не противоречат друг другу', () => {
    const records = blockedRecords();

    if (progressSaysNothingBlocked()) {
      expect(
        records,
        'PROGRESS.md говорит, что заблокированного нет, а BLOCKED.md содержит запись',
      ).toEqual([]);
    } else {
      expect(
        records.length,
        'PROGRESS.md говорит о блокировке, а записи в BLOCKED.md нет',
      ).toBeGreaterThan(0);
    }
  });

  it('описание формата не выглядит как запись', () => {
    // Пример внутри блока кода тоже попадает под шаблон: цикл читает строки,
    // а не разметку. Поэтому образца в этом файле быть не должно вовсе.
    const looksLikeRecord = read('docs/BLOCKED.md')
      .split('\n')
      .filter((line) => recordPattern('').test(line));

    expect(looksLikeRecord).toEqual([]);
  });

  it('образец записи лежит в CLAUDE.md, иначе его негде подсмотреть', () => {
    // Образец обязан быть без отступа: сдвинутый заголовок цикл не увидит,
    // и скопировавший его человек завёл бы невидимую блокировку.
    expect(read('CLAUDE.md')).toMatch(recordPattern('m'));
  });
});
