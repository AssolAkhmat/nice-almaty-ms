import { sql } from 'drizzle-orm';

import { getStorageProvider } from '@/adapters/storage';
import { getDb } from '@/db/client';
import { newRequestId, requestLogger } from '@/lib/logger';

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

function toCheckResult(health: StorageHealth): CheckResult {
  return health.status === 'ok'
    ? { status: 'ok' }
    : { status: health.status, reason: health.reason };
}

/**
 * Проверка живости: база данных и хранилище (docs/01-ARCHITECTURE.md).
 * Используется healthcheck-ом docker-compose и после развёртывания.
 */
export async function GET(): Promise<Response> {
  const requestId = newRequestId();
  const log = requestLogger(requestId);

  const storage = getStorageProvider();
  const [database, storageHealth] = await Promise.all([checkDatabase(), storage.checkHealth()]);

  const checks = {
    database,
    storage: { ...toCheckResult(storageHealth), driver: storage.driver },
  };

  const isHealthy = database.status === 'ok' && checks.storage.status !== 'error';

  if (!isHealthy) {
    log.error({ checks }, 'health check failed');
  }

  return Response.json(
    { status: isHealthy ? 'ok' : 'error', checks, request_id: requestId },
    { status: isHealthy ? 200 : 503 },
  );
}
