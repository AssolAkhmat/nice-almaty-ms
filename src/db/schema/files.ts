import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { houses } from './houses';
import { organizations } from './organizations';
import { residencies } from './residencies';
import { users } from './users';

/**
 * Файлы (docs/02-DATA-MODEL.md, «Файлы, уведомления, система»).
 *
 * Загрузка двухшаговая в обоих окружениях (D4): запись появляется со статусом
 * `pending` до того, как байты дошли до хранилища, и становится `ready` только
 * после проверки размера и типа. `failed` — байты не дошли или не сошлись
 * с заявленным: такая запись никогда не отдаётся наружу.
 */
export const fileProviderEnum = pgEnum('file_provider', ['gdrive', 'local', 'supabase']);

export const fileStatusEnum = pgEnum('file_status', ['pending', 'ready', 'failed']);

export const files = pgTable(
  'files',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /*
     * Проживание, к которому файл прикреплён. Через него идёт видимость:
     * дом и владелец берутся оттуда, а не хранятся копией. Копия однажды
     * разойдётся с оригиналом, и разойдётся молча.
     */
    residencyId: uuid('residency_id').references(() => residencies.id),
    /*
     * Дом, которому принадлежит файл, когда проживания у него нет: чек
     * к ущербу, расходу и строке коммуналки. Ровно одно из двух полей
     * заполнено — по нему и идёт видимость.
     */
    houseId: uuid('house_id').references(() => houses.id),
    provider: fileProviderEnum('provider').notNull(),
    /** Идентификатор объекта у провайдера; у локального диска его нет. */
    externalId: text('external_id'),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    /** До подтверждения — заявленный размер, после — фактический. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    originalName: text('original_name').notNull(),
    checksum: text('checksum'),
    status: fileStatusEnum('status').notNull().default('pending'),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    /** Что это за файл: тип документа и прочее из модуля-владельца. */
    scope: jsonb('scope').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /*
     * Две записи на один объект хранилища — это два разных набора прав
     * на одни и те же байты. База такого не допускает.
     */
    uniqueIndex('files_provider_path_unique').on(table.provider, table.path),
    index('files_residency_idx').on(table.residencyId),
    index('files_org_status_idx').on(table.orgId, table.status),
  ],
);

export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
