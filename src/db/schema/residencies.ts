import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { beds } from './beds';
import { houses } from './houses';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Проживание — связь «жилец ↔ дом ↔ место» (docs/00-PRD.md, глоссарий).
 * Роль и проживание разные сущности (D11): у админа тоже есть проживание,
 * обычно с ценой 0.
 */
export const residencyStatusEnum = pgEnum('residency_status', [
  'created',
  'profile_pending',
  'docs_pending',
  'deposit_pending',
  'active',
  'terminating',
  'archived',
]);

export const residencies = pgTable(
  'residencies',
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
    status: residencyStatusEnum('status').notNull().default('created'),
    contractStart: date('contract_start'),
    contractEnd: date('contract_end'),
    /** Дата оплаты депозита: до неё проживание не активно (§1.2). */
    moveInDate: date('move_in_date'),
    terminationRequestedAt: timestamp('termination_requested_at', { withTimezone: true }),
    moveOutDate: date('move_out_date'),
    depositDueDate: date('deposit_due_date'),
    depositAmount: bigint('deposit_amount', { mode: 'number' }),
    keysIssued: boolean('keys_issued').notNull().default(false),
    keysIssuedAt: timestamp('keys_issued_at', { withTimezone: true }),
    contractSignedAt: timestamp('contract_signed_at', { withTimezone: true }),
    /*
     * Ссылки на файлы без внешнего ключа: таблица `files` появляется в T2.6,
     * там же ключи и будут добавлены. Колонки заведены сразу, чтобы не менять
     * форму таблицы дважды.
     */
    contractFileId: uuid('contract_file_id'),
    signatureFileId: uuid('signature_file_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('residencies_house_status_idx').on(table.houseId, table.status),
    index('residencies_user_idx').on(table.userId),
  ],
);

export type Residency = typeof residencies.$inferSelect;
export type NewResidency = typeof residencies.$inferInsert;

/** Полуоткрытый интервал дат: `[начало, конец)`. Строится в src/db/period.ts. */
const daterange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'daterange';
  },
});

/**
 * Назначение места. Ограничения исключения добавлены рукописной частью
 * миграции: одно место не занять двумя проживаниями, и одно проживание
 * не занимает два места одновременно (инварианты 1 и 2 из `02-DATA-MODEL.md`).
 */
export const bedAssignments = pgTable(
  'bed_assignments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    residencyId: uuid('residency_id')
      .notNull()
      .references(() => residencies.id),
    bedId: uuid('bed_id')
      .notNull()
      .references(() => beds.id),
    /** Цена места для этого жильца, целое число тенге. У админа обычно 0. */
    price: bigint('price', { mode: 'number' }).notNull(),
    period: daterange('period').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('bed_assignments_bed_idx').on(table.bedId),
    index('bed_assignments_residency_idx').on(table.residencyId),
  ],
);

export type BedAssignment = typeof bedAssignments.$inferSelect;
export type NewBedAssignment = typeof bedAssignments.$inferInsert;
