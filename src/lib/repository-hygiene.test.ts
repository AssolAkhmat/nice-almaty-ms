import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/**
 * Ни один исходник не должен быть случайно перекрыт .gitignore.
 *
 * В фазе 1 строка `storage/` без якоря от корня проглотила каталог
 * `src/adapters/storage/`: локально всё собиралось, а на сервере сборка
 * падала с «Cannot find module». Локальная зелень такое не ловит —
 * ловит только этот тест.
 */
describe('гигиена репозитория', () => {
  it('под src/ нет файлов, перекрытых .gitignore', () => {
    const ignored = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', 'src'],
      { encoding: 'utf8' },
    ).trim();

    expect(ignored, `эти пути не попадут в репозиторий:\n${ignored}`).toBe('');
  });

  it('под messages/, e2e/ и src/db/migrations/ тоже', () => {
    const ignored = execFileSync(
      'git',
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        'messages',
        'e2e',
        'src/db/migrations',
      ],
      { encoding: 'utf8' },
    ).trim();

    expect(ignored, `эти пути не попадут в репозиторий:\n${ignored}`).toBe('');
  });
});
