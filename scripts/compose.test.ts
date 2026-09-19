import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож `docker-compose.yml`: свойства, которые ломались молча
 * при первом подъёме на VPS (19 сентября 2026, docs/08-DECISIONS.md).
 *
 * Ни одно из них не видно ни тестам приложения, ни сборке: compose
 * поднимается, healthcheck зелёный, а база открыта в интернет.
 */
const REPO_ROOT = join(import.meta.dirname, '..');

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/** Тело сервиса: строки после `  <имя>:` до следующего ключа того же или меньшего отступа. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${name}:`);

  if (start === -1) {
    throw new Error(`В docker-compose.yml нет сервиса ${name}`);
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));

  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * Публикации порта 5432, открытые не только на петлевом интерфейсе.
 * `5432:5432` слушает все адреса машины, и ufw его не закрывает:
 * Docker пишет правила iptables в обход него.
 */
function exposedPostgresPorts(block: string): string[] {
  const mappings = [...block.matchAll(/^\s+- ['"]?([^'"\n]+:5432)['"]?\s*$/gm)].map(
    (match) => match[1] ?? '',
  );

  return mappings.filter((mapping) => !mapping.startsWith('127.0.0.1:'));
}

function postgresMappings(block: string): number {
  return [...block.matchAll(/:5432['"]?\s*$/gm)].length;
}

describe('docker-compose.yml', () => {
  const compose = read('docker-compose.yml');

  it('postgres опубликован только на 127.0.0.1', () => {
    const block = serviceBlock(compose, 'postgres');

    expect(postgresMappings(block)).toBeGreaterThan(0);
    expect(exposedPostgresPorts(block)).toEqual([]);
  });
});

describe('сторож compose ловит нарушения', () => {
  it('публикацию на всех интерфейсах', () => {
    const block = ['    ports:', "      - '${POSTGRES_PORT:-5432}:5432'"].join('\n');

    expect(exposedPostgresPorts(block)).toEqual(['${POSTGRES_PORT:-5432}:5432']);
  });

  it('явный 0.0.0.0', () => {
    const block = ['    ports:', '      - "0.0.0.0:5432:5432"'].join('\n');

    expect(exposedPostgresPorts(block)).toEqual(['0.0.0.0:5432:5432']);
  });
});
