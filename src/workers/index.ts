import cron from 'node-cron';

import { loadEnv } from '@/lib/env/load';
import { logger, type Logger } from '@/lib/logger';
import { ALMATY_TIME_ZONE } from '@/lib/time';

/**
 * Раннер планировщика для режима Docker (docs/01-ARCHITECTURE.md).
 * Дёргает HTTP-эндпоинты /api/v1/cron/{job} с заголовком x-cron-secret;
 * идемпотентность обеспечивает таблица job_runs.
 *
 * В фазе 0 заданий нет: они появляются вместе с обработчиками в фазе 6.
 * На Vercel этот процесс не запускается — там расписание задаёт vercel.json.
 */
export interface ScheduledJob {
  /** Имя задания: совпадает с сегментом пути /api/v1/cron/{job}. */
  job: string;
  /** Выражение cron в зоне Asia/Almaty. */
  schedule: string;
}

export const JOBS: readonly ScheduledJob[] = [];

export function start(): void {
  const env = loadEnv();
  const log = logger.child({ component: 'worker' });

  for (const { job, schedule } of JOBS) {
    cron.schedule(
      schedule,
      () => {
        void run(job, env.APP_URL, env.CRON_SECRET, log);
      },
      { timezone: ALMATY_TIME_ZONE },
    );

    log.info({ job, schedule }, 'задание зарегистрировано');
  }

  log.info({ jobs: JOBS.length, timezone: ALMATY_TIME_ZONE }, 'планировщик запущен');
}

async function run(job: string, appUrl: string, secret: string, log: Logger): Promise<void> {
  try {
    const response = await fetch(new URL(`/api/v1/cron/${job}`, appUrl), {
      method: 'POST',
      headers: { 'x-cron-secret': secret },
    });

    log.info({ job, status: response.status }, 'задание выполнено');
  } catch (error) {
    log.error({ job, error }, 'задание не выполнено');
  }
}

start();

/*
 * Пока заданий нет, event loop нечем занять и процесс завершился бы сразу.
 * Таймер даёт ему живой дескриптор; когда задания появятся, их держит сам cron.
 */
const HOUR_MS = 60 * 60 * 1000;
const keepAlive = setInterval(() => {
  logger.debug({ component: 'worker', jobs: JOBS.length }, 'планировщик жив');
}, HOUR_MS);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(keepAlive);
    logger.info({ component: 'worker', signal }, 'планировщик остановлен');
    process.exit(0);
  });
}
