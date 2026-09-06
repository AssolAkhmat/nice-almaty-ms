import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Идемпотентность планировщика (docs/01-ARCHITECTURE.md, «Планировщик»).
 * Повторный вызов задания за тот же период не должен ничего дублировать,
 * это обеспечивает уникальность пары (job, period_key).
 *
 * Таблица инфраструктурная, не прикладная, поэтому `org_id` в ней нет.
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    job: text('job').notNull(),
    /** Ключ периода: для ежедневных — дата, для месячных — месяц. */
    periodKey: text('period_key').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull(),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('job_runs_job_period_key_unique').on(table.job, table.periodKey)],
);

export type JobRun = typeof jobRuns.$inferSelect;
export type NewJobRun = typeof jobRuns.$inferInsert;
