import { sql } from 'drizzle-orm';

import { getPdfRenderer } from '@/adapters/pdf';
import { getStorageProvider } from '@/adapters/storage';
import { getDb } from '@/db/client';
import { appliedMigrations, schemaProblem, EXPECTED_MIGRATIONS } from '@/db/schema-version';
import { newRequestId, requestLogger } from '@/lib/logger';

import type { PdfHealth } from '@/adapters/pdf';
import type { StorageHealth } from '@/adapters/storage';

export const dynamic = 'force-dynamic';

interface CheckResult {
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    await getDb().execute(sql`select 1`);
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : 'база данных недоступна',
    };
  }
}

/**
 * Схема базы против того, что ждёт код (указание владельца, 25 сентября 2026).
 *
 * `select 1` отвечал «ок» на лежащем сайте: база жива, а приложение при первом
 * же обращении к ней падает `SchemaOutdatedError`, потому что применённых
 * миграций меньше, чем в манифесте. Здоровье, которое не видит того, что
 * ломает рендер, — пятое утверждение, означающее меньше, чем говорит (I21).
 *
 * Числа под рукой: применённые миграции спрашиваются у базы, ожидаемые
 * лежат в манифесте.
 */
async function checkSchema(): Promise<CheckResult & { applied?: number; expected?: number }> {
  try {
    const applied = await appliedMigrations();
    const problem = schemaProblem(applied);

    return problem === null
      ? { status: 'ok', applied, expected: EXPECTED_MIGRATIONS }
      : {
          status: 'error',
          reason: `схема отстала от кода: ${problem}`,
          applied,
          expected: EXPECTED_MIGRATIONS,
        };
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : 'версию схемы прочитать не удалось',
    };
  }
}

function toCheckResult(health: PdfHealth | StorageHealth): CheckResult {
  return health.status === 'ok'
    ? { status: 'ok' }
    : { status: health.status, reason: health.reason };
}

/**
 * Проверка живости: база данных и хранилище (docs/01-ARCHITECTURE.md).
 * Используется healthcheck-ом docker-compose и после развёртывания.
 *
 * Печать проверяется только по запросу `?pdf=1`: она поднимает chromium,
 * и делать это каждые несколько секунд из healthcheck-а compose незачем.
 * После развёртывания на Vercel этот запрос — способ убедиться, что
 * договор напечатается, не заводя проживание (инцидент I12).
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const log = requestLogger(requestId);

  const withPdf = new URL(request.url).searchParams.get('pdf') === '1';

  const storage = getStorageProvider();
  const pdf = withPdf ? getPdfRenderer() : null;
  const [database, schema, storageHealth, pdfHealth] = await Promise.all([
    checkDatabase(),
    checkSchema(),
    storage.checkHealth(),
    pdf === null ? Promise.resolve(null) : pdf.checkHealth(),
  ]);

  const checks = {
    database,
    schema,
    storage: { ...toCheckResult(storageHealth), driver: storage.driver },
    ...(pdf !== null && pdfHealth !== null
      ? { pdf: { ...toCheckResult(pdfHealth), driver: pdf.driver } }
      : {}),
  };

  const isHealthy =
    database.status === 'ok' &&
    schema.status === 'ok' &&
    checks.storage.status !== 'error' &&
    (pdfHealth === null || pdfHealth.status === 'ok');

  if (!isHealthy) {
    log.error({ checks }, 'health check failed');
  }

  /*
   * Хеш коммита, из которого собран образ (указание владельца,
   * 25 сентября 2026). Пока версия не видна снаружи, «развёрнуто» — слово,
   * а не факт: 24 сентября образ два дня не пересобирался, а все признаки
   * успеха были на месте (разбор I19). Значение приходит в образ аргументом
   * сборки; `unknown` означает «собрано мимо `scripts/deploy.sh`».
   */
  return Response.json(
    {
      status: isHealthy ? 'ok' : 'error',
      commit: process.env.APP_COMMIT ?? 'unknown',
      checks,
      request_id: requestId,
    },
    { status: isHealthy ? 200 : 503 },
  );
}
