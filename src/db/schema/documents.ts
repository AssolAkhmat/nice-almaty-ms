import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { files } from './files';
import { organizations } from './organizations';
import { residencies } from './residencies';
import { users } from './users';

/**
 * Типы документов и загруженные документы (docs/02-DATA-MODEL.md,
 * docs/03-BUSINESS-RULES.md §1.3).
 *
 * Срок годности живёт в типе, а не в коде: суперадмин заводит новый тип
 * справки, и он появляется у всех жильцов со своим сроком. Правило одно,
 * значения разные — иначе каждый новый документ требовал бы правки кода.
 */
export const documentStatusEnum = pgEnum('document_status', ['uploaded', 'approved', 'rejected']);

export const documentTypes = pgTable(
  'document_types',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** Машинный код: `photo_3x4`, `dispensary`, `fluorography`. */
    code: text('code').notNull(),
    /** Название на трёх локалях: типы заводит суперадмин, а не разработчик. */
    nameI18n: jsonb('name_i18n').notNull().default({}),
    /** `null` — бессрочно (фото 3×4). */
    validityMonths: integer('validity_months'),
    /** Срок считается от даты выдачи: флюорография — от даты снимка. */
    requiresIssueDate: boolean('requires_issue_date').notNull().default(false),
    isRequired: boolean('is_required').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('document_types_org_code_unique').on(table.orgId, table.code)],
);

export const documents = pgTable(
  'documents',
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
    /*
     * Проживание, к которому относится документ. Через него идёт видимость
     * для админа — та же дорога, что у профиля и файлов (P2-5).
     */
    residencyId: uuid('residency_id')
      .notNull()
      .references(() => residencies.id),
    documentTypeId: uuid('document_type_id')
      .notNull()
      .references(() => documentTypes.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    /** Дата выдачи документа: для флюорографии — дата снимка (§1.3). */
    issueDate: date('issue_date'),
    validFrom: date('valid_from').notNull(),
    /** `null` — бессрочный документ. */
    validUntil: date('valid_until'),
    status: documentStatusEnum('status').notNull().default('uploaded'),
    rejectReason: text('reject_reason'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /*
     * Один файл — один документ. Иначе одна и та же справка числилась бы
     * дважды, и отклонение одной копии оставляло бы вторую принятой.
     */
    uniqueIndex('documents_file_unique').on(table.fileId),
    index('documents_residency_type_idx').on(table.residencyId, table.documentTypeId),
    index('documents_valid_until_idx').on(table.validUntil),
  ],
);

export type DocumentType = typeof documentTypes.$inferSelect;
export type NewDocumentType = typeof documentTypes.$inferInsert;
export type DocumentRecord = typeof documents.$inferSelect;
export type NewDocumentRecord = typeof documents.$inferInsert;
