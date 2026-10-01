import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Три списка заданий планировщика жили порознь, и расхождение не ловило ничто
 * (docs/01-ARCHITECTURE.md, «Планировщик»).
 *
 * Задание — это HTTP-эндпоинт плюс расписание, которое его дёргает. Если имя
 * есть в обработчиках и нет в раннере, задание не запустится никогда; если есть
 * в раннере и нет в обработчиках, раннер каждый раз получает 404. Оба случая
 * выглядят как тишина, а не как ошибка, — именно та природа, из-за которой
 * написано «правило увиденного отказа».
 *
 * Про Vercel. На боевой стоит Docker на VPS за Caddy, и файлы Vercel сегодня
 * ни на что не влияют. Но цель переключаемая (D2), поэтому списки не брошены:
 *
 * - `vercel.crons.example.json` — заготовка расписания для внешнего вызывающего
 *   (P1-5): полная, в UTC, и тест держит её полной. Источником истины она
 *   не является и не притворяется им;
 * - `vercel.json` крон-секции не содержит намеренно. Она там была и называла
 *   три задания из десяти: при переключении цели семь заданий молча
 *   не запускались бы. Неполное расписание хуже отсутствующего — отсутствующее
 *   видно сразу.
 */
const ROOT = join(import.meta.dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** Имена заданий из раннера Docker: `{ job: 'имя', schedule: ... }`. */
function runnerJobs(): Set<string> {
  const source = read('src/workers/index.ts');
  const names = [...source.matchAll(/\{\s*job: '([a-z-]+)'/g)].map((match) => match[1]);

  return new Set(names.filter((name): name is string => name !== undefined));
}

/**
 * Имена заданий из обработчиков `/api/v1/cron/[job]`.
 *
 * Ключи таблицы `HANDLERS` вычисляемые — `[MONTHLY_INVOICES_JOB]`, — поэтому
 * имя берётся в два шага: сначала идентификатор из таблицы, потом его значение
 * из сервиса. Так тест читает ровно то, что исполняется, а не копию списка.
 */
function handlerJobs(): Set<string> {
  const route = read('src/app/api/v1/cron/[job]/route.ts');
  const table = route.slice(route.indexOf('const HANDLERS'));
  const identifiers = [...table.matchAll(/\[([A-Z][A-Z_]+)\]:/g)].map((match) => match[1]);

  expect(identifiers.length).toBeGreaterThan(0);

  const names = new Set<string>();

  for (const identifier of identifiers) {
    if (identifier === undefined) {
      continue;
    }

    const imported = new RegExp(`export const ${identifier} = '([a-z-]+)'`);

    let value: string | undefined;

    for (const match of route.matchAll(/from '@\/services\/([a-z-]+)'/g)) {
      const serviceFile = match[1];

      if (serviceFile === undefined) {
        continue;
      }

      const found = imported.exec(read(`src/services/${serviceFile}.ts`));

      if (found?.[1] !== undefined) {
        value = found[1];
        break;
      }
    }

    expect(value, `значение ${identifier} не найдено в сервисах`).toBeDefined();

    if (value !== undefined) {
      names.add(value);
    }
  }

  return names;
}

/** Имена заданий из заготовки расписания Vercel. */
function exampleJobs(): Set<string> {
  const parsed = JSON.parse(read('vercel.crons.example.json')) as {
    crons?: readonly { path: string }[];
  };

  return new Set((parsed.crons ?? []).map((cron) => cron.path.replace('/api/v1/cron/', '')));
}

describe('списки заданий планировщика', () => {
  it('раннер Docker и обработчики называют один и тот же набор', () => {
    expect([...handlerJobs()].sort()).toEqual([...runnerJobs()].sort());
  });

  it('заготовка расписания Vercel полна', () => {
    expect([...exampleJobs()].sort()).toEqual([...handlerJobs()].sort());
  });

  it('vercel.json не содержит неполного расписания', () => {
    const parsed = JSON.parse(read('vercel.json')) as { crons?: unknown };

    expect(parsed.crons, 'расписание Vercel живёт в заготовке, а не в vercel.json').toBeUndefined();
  });
});
