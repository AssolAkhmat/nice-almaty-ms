import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Счётчик попыток входа (docs/08-DECISIONS.md, P1-2).
 * Хранится в базе, а не в памяти: на serverless процессы не разделяют состояние.
 *
 * Ключи: `login:phone:+7XXXXXXXXXX` и `login:ip:X.X.X.X`.
 * Окно 15 минут, порог 10 попыток. Просроченные строки удаляются лениво
 * при записи; отдельное задание на очистку появится в фазе 6.
 */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
});

export type RateLimit = typeof rateLimits.$inferSelect;
export type NewRateLimit = typeof rateLimits.$inferInsert;
