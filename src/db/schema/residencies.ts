import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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
    /**
     * Номер договора, «ГГГГ-НННН». Присваивает система при заведении
     * проживания: вводимый руками номер рано или поздно повторится (T8.1).
     * Пусто у проживаний, заведённых до появления нумерации, — им номер
     * достаётся при первой сборке договора.
     */
    contractNumber: text('contract_number'),
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
    /**
     * Версия шаблона, по которой собран договор (T8.5). Пусто, пока договор
     * не собирали. Подпись и пересборка идут по ней, а не по действующему
     * шаблону: подписанный документ не должен меняться задним числом.
     */
    contractTemplateId: uuid('contract_template_id'),
    contractFileId: uuid('contract_file_id'),
    signatureFileId: uuid('signature_file_id'),
    /**
     * Подпись исполнителя, вложенная в договор при подписании
     * (указание владельца, 22 сентября 2026).
     *
     * Снимок, а не ссылка на настройку сети: владелица может сменить подпись,
     * и уже подписанные договоры обязаны сохранить ту, что была на момент
     * подписания. Та же мысль, что версия шаблона в T8.5 — документ,
     * который уже подписали, не меняется задним числом.
     */
    ownerSignatureFileId: uuid('owner_signature_file_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('residencies_house_status_idx').on(table.houseId, table.status),
    index('residencies_user_idx').on(table.userId),
    // Номер уникален в пределах сети: двух договоров с одним номером не бывает.
    uniqueIndex('residencies_org_contract_number_unique').on(table.orgId, table.contractNumber),
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
 *
 * Дом назначения хранится колонкой и составным ключом приколочен к дому
 * места: `(bed_id, house_id) → beds(id, house_id)`. Это не украшение —
 * из этой колонки читается история домов жильца, без которой переселение
 * между домами не отличить от переезда внутри дома (указание владельца,
 * 22 сентября 2026). Слово «дом сейчас» живёт в `residencies.house_id`,
 * слово «дом тогда» — здесь.
 *
 * Правило «место своего дома» держит триггер `bed_assignment_house_matches`
 * (миграция 0028): он сверяет дом назначения с домом проживания в момент
 * назначения. Составным ключом на `residencies(id, house_id)` это выразить
 * нельзя — такой ключ запретил бы саму смену дома, потому что старые
 * назначения указывали бы на прежний дом, а переписывать их значило бы
 * переписывать историю.
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
    /** Дом места на момент назначения: «дом тогда», в отличие от «дома сейчас». */
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
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
    index('bed_assignments_house_idx').on(table.houseId),
    foreignKey({
      columns: [table.bedId, table.houseId],
      foreignColumns: [beds.id, beds.houseId],
      name: 'bed_assignments_bed_house_fk',
    }),
  ],
);

export type BedAssignment = typeof bedAssignments.$inferSelect;
export type NewBedAssignment = typeof bedAssignments.$inferInsert;
