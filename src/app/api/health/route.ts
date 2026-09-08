import { sql } from 'drizzle-orm';

import { getPdfRenderer } from '@/adapters/pdf';
import { getStorageProvider } from '@/adapters/storage';
import { getDb } from '@/db/client';
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
  const [database, storageHealth, pdfHealth] = await Promise.all([
    checkDatabase(),
    storage.checkHealth(),
    pdf === null ? Promise.resolve(null) : pdf.checkHealth(),
  ]);

  const checks = {
    database,
    storage: { ...toCheckResult(storageHealth), driver: storage.driver },
    ...(pdf !== null && pdfHealth !== null
      ? { pdf: { ...toCheckResult(pdfHealth), driver: pdf.driver } }
      : {}),
  };

  const isHealthy =
    database.status === 'ok' &&
    checks.storage.status !== 'error' &&
    (pdfHealth === null || pdfHealth.status === 'ok');

  if (!isHealthy) {
    log.error({ checks }, 'health check failed');
  }

  return Response.json(
    { status: isHealthy ? 'ok' : 'error', checks, request_id: requestId },
    { status: isHealthy ? 200 : 503 },
  );
}
