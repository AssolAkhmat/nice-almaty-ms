import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { API_OPERATIONS, buildOpenApiDocument } from './openapi';

/**
 * Спецификация не должна расходиться с кодом (docs/06-API.md).
 *
 * Список маршрутов собирается из файловой системы: каждый `route.ts` под
 * `src/app/api/v1` — это существующий маршрут, и он либо описан снаружи,
 * либо явно назван служебным. Иначе документация тихо отстаёт от кода,
 * а замечает это чужой разработчик, а не тест.
 */
const ROUTES_ROOT = fileURLToPath(new URL('../../app/api/v1', import.meta.url)).replace(
  /^\/(\w:)/,
  '$1',
);

/** Задания планировщика и спецификация: внутренние пути, ботам не нужны. */
const INTERNAL_PATHS = ['/cron/{job}', '/openapi.json'];

function routePaths(directory: string, prefix = ''): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const segment = entry.name.startsWith('[')
        ? `/{${entry.name.slice(1, -1)}}`
        : `/${entry.name}`;

      found.push(...routePaths(join(directory, entry.name), `${prefix}${segment}`));
      continue;
    }

    if (entry.name === 'route.ts') {
      found.push(prefix === '' ? '/' : prefix);
    }
  }

  return found;
}

describe('спецификация и код', () => {
  it('каждый маршрут описан или назван служебным', () => {
    const described = new Set([...Object.keys(API_OPERATIONS), ...INTERNAL_PATHS]);
    const missing = routePaths(ROUTES_ROOT).filter((path) => !described.has(path));

    expect(missing, `маршруты без описания:\n${missing.join('\n')}`).toEqual([]);
  });

  it('в описании нет несуществующих маршрутов', () => {
    const actual = new Set(routePaths(ROUTES_ROOT));
    const extra = Object.keys(API_OPERATIONS).filter((path) => !actual.has(path));

    expect(extra, `описаны, но не существуют:\n${extra.join('\n')}`).toEqual([]);
  });
});

describe('документ', () => {
  const document = buildOpenApiDocument({ serverUrl: 'https://nice.local/api/v1' });

  it('это OpenAPI 3.1 с адресом сервера', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.servers).toEqual([{ url: 'https://nice.local/api/v1' }]);
  });

  it('у каждой операции есть ответ и способ входа', () => {
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;

    for (const [path, operations] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        expect(operation.responses, `${method} ${path}`).toBeDefined();
        expect(operation.security, `${method} ${path}`).toBeDefined();
      }
    }
  });

  it('схемы ответов — настоящий JSON Schema, а не заглушка', () => {
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
    const houses = paths['/houses']?.get as {
      responses: {
        '200': { content: { 'application/json': { schema: Record<string, unknown> } } };
      };
    };
    const schema = houses.responses['200'].content['application/json'].schema;

    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('data');
  });

  it('задания планировщика в документ не попадают', () => {
    expect(Object.keys(document.paths as object).some((path) => path.startsWith('/cron'))).toBe(
      false,
    );
  });
});
