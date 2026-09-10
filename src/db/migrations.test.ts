import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

describe('миграции', () => {
  it('первая миграция существует', () => {
    const files = migrationFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^0000_/);
  });

  /**
   * Блок с расширением дописан к сгенерированной миграции руками.
   * Если кто-то перегенерирует миграции и потеряет его, фаза 2
   * не сможет создать EXCLUDE-ограничение на bed_assignments.
   */
  it('первая миграция ставит btree_gist и переживает отсутствие прав', () => {
    const sql = readMigration(migrationFiles()[0] ?? '');

    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
    expect(sql).toContain('insufficient_privilege');
    expect(sql).toContain('RAISE WARNING');
  });

  it('первая миграция создаёт job_runs с уникальностью пары job + period_key', () => {
    const sql = readMigration(migrationFiles()[0] ?? '');

    expect(sql).toContain('CREATE TABLE "job_runs"');
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*"job"\s*,\s*"period_key"/);
  });

  /**
   * Дописано руками к сгенерированной миграции: без этого UPDATE проверка
   * «дырка обязана назвать причину» не пройдёт по старым назначениям,
   * и миграция упадёт на любой базе, где ротации уже материализованы.
   */
  it('миграция фазы 10 заполняет причину у старых назначений до проверки', () => {
    const name = migrationFiles().find((file) => file.startsWith('0021_')) ?? '';
    const sql = readMigration(name);
    const backfill = sql.indexOf('UPDATE "rotation_assignments" SET "empty_reason"');
    const constraint = sql.indexOf('rotation_assignments_empty_has_reason');

    expect(backfill).toBeGreaterThan(-1);
    expect(constraint).toBeGreaterThan(backfill);
  });

  /** Тот же случай, что и выше: без UPDATE проверка не встанет на старые ряды. */
  it('миграция фазы 10 чинит день недели рядов до проверки диапазона', () => {
    const name = migrationFiles().find((file) => file.startsWith('0023_')) ?? '';
    const sql = readMigration(name);
    const backfill = sql.indexOf('UPDATE "rotation_rows" SET "weekday" = 0');
    const constraint = sql.indexOf('rotation_rows_weekday_range');

    expect(backfill).toBeGreaterThan(-1);
    expect(constraint).toBeGreaterThan(backfill);
  });

  it('журнал drizzle перечисляет все файлы миграций', () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as {
      entries: { tag: string }[];
    };

    expect(journal.entries.map((entry) => `${entry.tag}.sql`).sort()).toEqual(migrationFiles());
  });
});
