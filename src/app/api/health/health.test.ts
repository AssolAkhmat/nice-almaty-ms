import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SchemaVersion from '@/db/schema-version';

type SchemaVersionModule = typeof SchemaVersion;

/**
 * Здоровье обязано видеть расхождение схемы и кода (указание владельца,
 * 25 сентября 2026).
 *
 * `select 1` отвечал «ок» на лежащем сайте: база жива, а защищённая зона
 * падала `SchemaOutdatedError` при первом обращении к ней, потому что
 * применённых миграций меньше, чем в манифесте. Здоровье, не замечающее
 * того, что ломает рендер, — утверждение, означающее меньше, чем говорит
 * (разбор I21).
 *
 * Проверка подменяет только число применённых миграций: остальное —
 * настоящий код маршрута.
 */
const applied = vi.hoisted(() => ({ value: 0 }));

vi.mock('@/db/schema-version', async () => {
  const actual = await vi.importActual<SchemaVersionModule>('@/db/schema-version');

  return {
    ...actual,
    appliedMigrations: () => Promise.resolve(applied.value),
  };
});

vi.mock('@/db/client', () => ({
  getDb: () => ({ execute: () => Promise.resolve([{ ok: 1 }]) }),
}));

vi.mock('@/adapters/storage', () => ({
  getStorageProvider: () => ({
    driver: 'local',
    checkHealth: () => Promise.resolve({ status: 'ok' as const }),
  }),
}));

vi.mock('@/adapters/pdf', () => ({
  getPdfRenderer: () => ({
    driver: 'none',
    checkHealth: () => Promise.resolve({ status: 'ok' as const }),
  }),
}));

const { GET } = await import('./route');
const { EXPECTED_MIGRATIONS } = await import('@/db/schema-version');

interface HealthBody {
  status: string;
  commit: string;
  checks: { schema: { status: string; reason?: string; applied?: number; expected?: number } };
}

async function health(): Promise<{ code: number; body: HealthBody }> {
  const response = await GET(new Request('http://localhost/api/health'));

  return { code: response.status, body: (await response.json()) as HealthBody };
}

beforeEach(() => {
  applied.value = EXPECTED_MIGRATIONS;
});

describe('проверка живости', () => {
  it('со свежей схемой отвечает 200 и называет числа', async () => {
    const { code, body } = await health();

    expect(code).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks.schema).toEqual({
      status: 'ok',
      applied: EXPECTED_MIGRATIONS,
      expected: EXPECTED_MIGRATIONS,
    });
  });

  /* Та самая поломка: база отстала на одну миграцию, сайт лежит. */
  it('с отставшей схемой отвечает 503, а не «ок»', async () => {
    applied.value = EXPECTED_MIGRATIONS - 1;

    const { code, body } = await health();

    expect(code).toBe(503);
    expect(body.status).toBe('error');
    expect(body.checks.schema.status).toBe('error');
    expect(body.checks.schema.reason).toContain('схема отстала');
  });

  it('база впереди кода ошибкой не считается: так выглядит выкатка', async () => {
    applied.value = EXPECTED_MIGRATIONS + 1;

    const { code } = await health();

    expect(code).toBe(200);
  });

  it('отдаёт версию образа', async () => {
    const { body } = await health();

    expect(body.commit).toBeDefined();
  });
});
