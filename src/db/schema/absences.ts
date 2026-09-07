import { sql } from 'drizzle-orm';
import { date, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { files } from './files';
import { houses } from './houses';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Отсутствия (docs/02-DATA-MODEL.md, docs/03-BUSINESS-RULES.md §9).
 *
 * Три типа с разными последствиями: краткосрочное фиксируется фактом,
 * долгосрочное и болезнь требуют одобрения. Причина обязательна во всех —
 * это единственное поле, которое §9 называет обязательным прямо.
 */
export const absenceTypeEnum = pgEnum('absence_type', ['short', 'long', 'sick']);

export const absenceStatusEnum = pgEnum('absence_status', ['pending', 'approved', 'rejected']);

export const absences = pgTable(
  'absences',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    type: absenceTypeEnum('type').notNull(),
    startDate: date('start_date').notNull(),
    /** Пусто у краткосрочного: оно про один вечер. */
    endDate: date('end_date'),
    /** Ориентировочное время возвращения — только у краткосрочного. */
    startAt: timestamp('start_at', { withTimezone: true }),
    reason: text('reason').notNull(),
    status: absenceStatusEnum('status').notNull().default('pending'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Причина отказа: §9 требует её при отклонении. */
    reviewNote: text('review_note'),
    /** Справка при болезни — по желанию. */
    docFileId: uuid('doc_file_id').references(() => files.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('absences_house_idx').on(table.houseId, table.startDate),
    index('absences_user_idx').on(table.userId, table.startDate),
    index('absences_status_idx').on(table.houseId, table.status),
  ],
);

export type Absence = typeof absences.$inferSelect;
export type NewAbsence = typeof absences.$inferInsert;
