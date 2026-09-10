import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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

import { areas } from './areas';
import { beds } from './beds';
import { houses } from './houses';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Ротации (docs/02-DATA-MODEL.md раздел «Ротации», docs/03-BUSINESS-RULES.md §6).
 *
 * Расписание материализуется занятиями, а не считается на лету: занятие можно
 * перенести, отменить и переназначить, и всё это должно пережить перезагрузку
 * страницы. Сама сетка при этом остаётся детерминированной — `src/domain/rotation-grid.ts`.
 */

/** Обычная уборка и генеральная: у зоны может быть по одному чек-листу на каждую. */
export const checklistTypeEnum = pgEnum('checklist_type', ['regular', 'general']);

/**
 * Чек-лист зоны: что именно убирать и сколько человек для этого нужно.
 * `people_needed` определяет длину `D` в сетке (§6.2) и число назначений
 * у каждого занятия (инвариант 8).
 */
export const areaChecklists = pgTable(
  'area_checklists',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    areaId: uuid('area_id')
      .notNull()
      .references(() => areas.id),
    type: checklistTypeEnum('type').notNull(),
    title: text('title').notNull(),
    /** Массив строк-пунктов на языке дома: заводит их админ, а не система. */
    items: jsonb('items').notNull().default([]),
    peopleNeeded: integer('people_needed').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // До двух чек-листов на зону — по одному каждого вида (§6.1).
    uniqueIndex('area_checklists_area_type_unique').on(table.areaId, table.type),
  ],
);

/**
 * Группа допуска: кто вправе убирать зону (§6.1).
 *
 * Правило лежит целиком в `rule`: основа (`all` / `male` / `female` / `room`),
 * комната для основы `room` и явные списки включений и исключений —
 * «двор: парни, кроме Азамата». Основа перечислением в базе не заводится:
 * значение живёт внутри jsonb, который PostgreSQL всё равно не проверяет,
 * и отдельный тип без единой колонки был бы мусором в схеме (P3-35).
 */
export const eligibilityGroups = pgTable(
  'eligibility_groups',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    name: text('name').notNull(),
    /** `{ base, areaId?, includeUserIds[], excludeUserIds[] }` */
    rule: jsonb('rule').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('eligibility_groups_house_idx').on(table.houseId, table.name)],
);

/** Какая группа допущена к зоне по какому виду уборки. */
export const areaEligibility = pgTable(
  'area_eligibility',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    areaId: uuid('area_id')
      .notNull()
      .references(() => areas.id),
    checklistType: checklistTypeEnum('checklist_type').notNull(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => eligibilityGroups.id),
  },
  (table) => [
    uniqueIndex('area_eligibility_unique').on(table.areaId, table.checklistType, table.groupId),
  ],
);

/** Ряд общих зон и ряд комнаты (§6.4) считаются одной формулой, различаясь составом. */
export const rotationRowTypeEnum = pgEnum('rotation_row_type', ['common', 'room']);

/**
 * Ряд ротаций: дом, день недели, дата первой ротации, упорядоченные слоты и зоны.
 * От `start_date` считается номер недели `k`, поэтому дата — бизнес-дата без времени.
 */
export const rotationRows = pgTable(
  'rotation_rows',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    name: text('name').notNull(),
    type: rotationRowTypeEnum('type').notNull(),
    /** 0 — воскресенье, 6 — суббота: как `weekday` в `src/lib/time.ts`. */
    weekday: integer('weekday').notNull(),
    startDate: date('start_date').notNull(),
    /** Комната ряда типа `room` (§6.4); у ряда общих зон её нет. */
    roomAreaId: uuid('room_area_id').references(() => areas.id),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rotation_rows_house_idx').on(table.houseId, table.sortOrder),
    /*
     * Один действующий ряд общих зон на дом и день недели (план фазы 10, §2.2):
     * два ряда на среду означали бы два состава и две очереди в один день.
     * Комнатных рядов на воскресенье столько же, сколько комнат, — они сюда
     * не попадают, и снятый с работы ряд места не занимает.
     */
    uniqueIndex('rotation_rows_common_weekday_unique')
      .on(table.houseId, table.weekday)
      .where(sql`${table.type} = 'common' and ${table.isActive}`),
    /*
     * День недели — 0 (воскресенье) … 6 (суббота), как в `src/lib/time.ts`.
     * Сид однажды писал сюда 7 по календарю ISO: даты у ряда были верные,
     * а день недели не совпадал ни с одним настоящим, и экран не знал,
     * как его назвать.
     */
    check('rotation_rows_weekday_range', sql`${table.weekday} between 0 and 6`),
    check(
      'rotation_rows_room_has_area',
      sql`(${table.type} = 'room' and ${table.roomAreaId} is not null) or (${table.type} <> 'room' and ${table.roomAreaId} is null)`,
    ),
  ],
);

/**
 * Слот ряда — позиция в цикле, привязанная к месту, а не к человеку (§6.1).
 * Сменился жилец — позиция сохранилась, и сетка не пересобирается.
 */
export const rotationRowSlots = pgTable(
  'rotation_row_slots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    rowId: uuid('row_id')
      .notNull()
      .references(() => rotationRows.id),
    position: integer('position').notNull(),
    bedId: uuid('bed_id')
      .notNull()
      .references(() => beds.id),
  },
  (table) => [
    uniqueIndex('rotation_row_slots_position_unique').on(table.rowId, table.position),
    // Место входит в ряд один раз: иначе один жилец получил бы две зоны за неделю.
    uniqueIndex('rotation_row_slots_bed_unique').on(table.rowId, table.bedId),
  ],
);

/**
 * Зона ряда. `people_needed` копируется сюда из чек-листа в момент сборки ряда:
 * ряд обязан оставаться проверяемым на инвариант 9 без обращения к чек-листу.
 */
export const rotationRowZones = pgTable(
  'rotation_row_zones',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    rowId: uuid('row_id')
      .notNull()
      .references(() => rotationRows.id),
    position: integer('position').notNull(),
    areaId: uuid('area_id')
      .notNull()
      .references(() => areas.id),
    checklistId: uuid('checklist_id')
      .notNull()
      .references(() => areaChecklists.id),
    peopleNeeded: integer('people_needed').notNull().default(1),
  },
  (table) => [
    uniqueIndex('rotation_row_zones_position_unique').on(table.rowId, table.position),
    uniqueIndex('rotation_row_zones_area_unique').on(table.rowId, table.areaId, table.checklistId),
  ],
);

/**
 * Версия состава ряда (план фазы 10, §2.2): кто участвует, начиная с даты.
 *
 * Правка «с 15 октября» заводит новую версию, прошлые недели остаются
 * на старой. Счётчик недель `k` версией не сбивается — он считается
 * от даты старта ряда (P10-5).
 */
export const rotationRowRosters = pgTable(
  'rotation_row_rosters',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    rowId: uuid('row_id')
      .notNull()
      .references(() => rotationRows.id),
    effectiveFrom: date('effective_from').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('rotation_row_rosters_row_date_unique').on(table.rowId, table.effectiveFrom),
  ],
);

/** Место в версии состава: позиция привязана к месту, а не к человеку (D12). */
export const rotationRowRosterSlots = pgTable(
  'rotation_row_roster_slots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    rosterId: uuid('roster_id')
      .notNull()
      .references(() => rotationRowRosters.id),
    position: integer('position').notNull(),
    bedId: uuid('bed_id')
      .notNull()
      .references(() => beds.id),
  },
  (table) => [
    uniqueIndex('rotation_row_roster_slots_position_unique').on(table.rosterId, table.position),
    // Место входит в состав один раз: иначе один жилец получил бы две зоны за день.
    uniqueIndex('rotation_row_roster_slots_bed_unique').on(table.rosterId, table.bedId),
  ],
);

/**
 * Версия нормы дня (план фазы 10, §2.3): какие зоны убираются в этот день.
 *
 * Норма привязана к ряду, а не к паре «дом и день недели»: комнатных рядов
 * на воскресенье столько же, сколько комнат, и общая норма дня их бы склеила
 * (P10-6). Ряд общих зон на день недели один, поэтому для него это то же самое.
 */
export const rotationDayNorms = pgTable(
  'rotation_day_norms',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    rowId: uuid('row_id')
      .notNull()
      .references(() => rotationRows.id),
    effectiveFrom: date('effective_from').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('rotation_day_norms_row_date_unique').on(table.rowId, table.effectiveFrom),
  ],
);

/**
 * Зона нормы: чек-лист и число людей именно в этот день.
 *
 * `people` берётся по умолчанию из `people_needed` чек-листа, но живёт
 * отдельно: двор в воскресенье — двое, а в чек-листе то же число нужно
 * генеральной уборке (§6.5, умолчание 5 плана).
 */
export const rotationDayNormZones = pgTable(
  'rotation_day_norm_zones',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    normId: uuid('norm_id')
      .notNull()
      .references(() => rotationDayNorms.id),
    position: integer('position').notNull(),
    areaId: uuid('area_id')
      .notNull()
      .references(() => areas.id),
    checklistId: uuid('checklist_id')
      .notNull()
      .references(() => areaChecklists.id),
    people: integer('people').notNull().default(1),
  },
  (table) => [
    uniqueIndex('rotation_day_norm_zones_position_unique').on(table.normId, table.position),
    uniqueIndex('rotation_day_norm_zones_area_unique').on(
      table.normId,
      table.areaId,
      table.checklistId,
    ),
    check('rotation_day_norm_zones_people_positive', sql`${table.people} >= 1`),
  ],
);

/** Вид занятия: обычное по ряду, комнатное, генеральная уборка, внеплановое. */
export const rotationOccurrenceTypeEnum = pgEnum('rotation_occurrence_type', [
  'regular',
  'room',
  'general',
  'extra',
]);

/** Отменённое занятие не влияет ни на рейтинг, ни на долг (§7). */
export const rotationStatusEnum = pgEnum('rotation_status', [
  'scheduled',
  'done',
  'missed',
  'cancelled',
]);

/**
 * Занятие: одна зона в один день.
 *
 * `cycle_index` — номер недели `k`, вычисленный при материализации по плановой
 * дате. Он хранится, а не считается заново: перенос занятия меняет дату,
 * а §6.6 обещает, что ряд от переноса не пересобирается.
 */
export const rotationOccurrences = pgTable(
  'rotation_occurrences',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    /** Пусто у внеплановой и генеральной уборки: ряда за ними нет. */
    rowId: uuid('row_id').references(() => rotationRows.id),
    areaId: uuid('area_id')
      .notNull()
      .references(() => areas.id),
    checklistId: uuid('checklist_id')
      .notNull()
      .references(() => areaChecklists.id),
    date: date('date').notNull(),
    type: rotationOccurrenceTypeEnum('type').notNull(),
    status: rotationStatusEnum('status').notNull().default('scheduled'),
    /** Заполняется при переносе: исходная дата остаётся видимой в календаре. */
    movedFromDate: date('moved_from_date'),
    cycleIndex: integer('cycle_index'),
    /**
     * Сколько человек убирает зону именно в этот день. Берётся из нормы при
     * материализации; правка недели меняет его (двор 2 -> 1, §2.6). Инвариант 8
     * считает назначения по этому числу, а не по чек-листу.
     */
    peopleNeeded: integer('people_needed').notNull().default(1),
    /** Пусто у сгенерированного расписанием; у внепланового — кто завёл. */
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rotation_occurrences_house_date_idx').on(table.houseId, table.date),
    /*
     * Повторная генерация того же периода не создаёт вторых занятий (T4.5):
     * ряд, зона и дата вместе определяют занятие однозначно. Внеплановые
     * и генеральные идут без ряда и под это ограничение не попадают.
     */
    uniqueIndex('rotation_occurrences_row_area_date_unique')
      .on(table.rowId, table.areaId, table.date)
      .where(sql`${table.rowId} is not null`),
    check('rotation_occurrences_people_positive', sql`${table.peopleNeeded} >= 1`),
  ],
);

/**
 * Почему у зоны нет исполнителя (§2.5 плана фазы 10): место пустует,
 * человек отсутствует, очередь отдала зону недопущенному или людей меньше зон.
 */
export const rotationEmptyReasonEnum = pgEnum('rotation_empty_reason', [
  'empty_bed',
  'absent',
  'not_eligible',
  'no_one',
]);

/** Откуда взялось назначение: сетка, рука админа или долг по доп. ротациям. */
export const rotationAssignmentSourceEnum = pgEnum('rotation_assignment_source', [
  'auto',
  'manual',
  'debt',
]);

/**
 * Состояние назначения. `needs_reassignment` — место пустует или исполнитель
 * отсутствует: система не пересобирает ряд и не сдвигает остальных, а показывает
 * админу задачу «отмени или назначь вручную» (§6.3).
 */
export const rotationAssignmentStateEnum = pgEnum('rotation_assignment_state', [
  'assigned',
  'needs_reassignment',
  'confirmed',
  'missed',
  'cancelled',
]);

/** Назначение: кто убирает зону в этот день. Их ровно `people_needed` (инвариант 8). */
export const rotationAssignments = pgTable(
  'rotation_assignments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => rotationOccurrences.id),
    /** Пусто, пока назначение ждёт решения админа: место пустует. */
    userId: uuid('user_id').references(() => users.id),
    /** Позиция слота в ряду, из которой пришёл исполнитель. */
    slotPosition: integer('slot_position'),
    /** Причина пустоты; у назначения с исполнителем её нет. */
    emptyReason: rotationEmptyReasonEnum('empty_reason'),
    /** Кто стоял в очереди на зону, но не допущен к ней (§2.5). */
    queuedUserId: uuid('queued_user_id').references(() => users.id),
    /** Галочка «списать доп. ротацию»: долг уменьшится при подтверждении (P10-3). */
    writeOffDebt: boolean('write_off_debt').notNull().default(false),
    source: rotationAssignmentSourceEnum('source').notNull().default('auto'),
    state: rotationAssignmentStateEnum('state').notNull().default('assigned'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    /** Оценка 1–10, видна только админу и суперадмину (§7). */
    score: integer('score'),
    scoredBy: uuid('scored_by').references(() => users.id),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
    photoFileIds: uuid('photo_file_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rotation_assignments_occurrence_idx').on(table.occurrenceId),
    index('rotation_assignments_user_idx').on(table.userId),
    /*
     * Дырка обязана называть причину, а исполнитель — её не иметь: по этой
     * колонке дэшборд собирает «Требует решения», и назначение без причины
     * молча выпало бы из списка задач админа.
     */
    check(
      'rotation_assignments_empty_has_reason',
      sql`(${table.userId} is null) = (${table.emptyReason} is not null)`,
    ),
  ],
);

/**
 * Долг по дополнительным ротациям (§7) — книга со знаком (§2.7 плана фазы 10).
 *
 * Строка `+1` заводится закрытием дня и порогом рейтинга, строка `−1` —
 * выполненной доп. ротацией с галочкой списания. Баланс — сумма несгоревших
 * строк, и он может уйти в минус: минус допустим, это запас, и следующее
 * «не выполнена» сначала съедает его. Долг не сгорает от времени,
 * но обнуляется 1 июля: дата записана в самой строке.
 */
export const rotationDebts = pgTable(
  'rotation_debts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    /** Шаг долга: `+1` — начисление, `−1` — списание. */
    delta: integer('delta').notNull().default(1),
    /** Назначение, из которого родилась строка: за которое начислен или которым списан. */
    sourceAssignmentId: uuid('source_assignment_id').references(() => rotationAssignments.id),
    expiresAt: date('expires_at').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rotation_debts_user_idx').on(table.userId, table.expiresAt),
    check('rotation_debts_delta_step', sql`${table.delta} in (-1, 1)`),
  ],
);

/** Шапка и футер текста для группы, раздельно для обычной и генеральной уборки (§6.7). */
export const rotationTemplatesSettings = pgTable(
  'rotation_templates_settings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    type: checklistTypeEnum('type').notNull(),
    headerI18n: jsonb('header_i18n').notNull().default({}),
    footerI18n: jsonb('footer_i18n').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('rotation_templates_house_type_unique').on(table.houseId, table.type)],
);

export type AreaChecklist = typeof areaChecklists.$inferSelect;
export type NewAreaChecklist = typeof areaChecklists.$inferInsert;
export type EligibilityGroup = typeof eligibilityGroups.$inferSelect;
export type NewEligibilityGroup = typeof eligibilityGroups.$inferInsert;
export type AreaEligibility = typeof areaEligibility.$inferSelect;
export type NewAreaEligibility = typeof areaEligibility.$inferInsert;
export type RotationRow = typeof rotationRows.$inferSelect;
export type NewRotationRow = typeof rotationRows.$inferInsert;
export type RotationRowSlot = typeof rotationRowSlots.$inferSelect;
export type NewRotationRowSlot = typeof rotationRowSlots.$inferInsert;
export type RotationRowZone = typeof rotationRowZones.$inferSelect;
export type NewRotationRowZone = typeof rotationRowZones.$inferInsert;
export type RotationRowRoster = typeof rotationRowRosters.$inferSelect;
export type NewRotationRowRoster = typeof rotationRowRosters.$inferInsert;
export type RotationRowRosterSlot = typeof rotationRowRosterSlots.$inferSelect;
export type NewRotationRowRosterSlot = typeof rotationRowRosterSlots.$inferInsert;
export type RotationDayNorm = typeof rotationDayNorms.$inferSelect;
export type NewRotationDayNorm = typeof rotationDayNorms.$inferInsert;
export type RotationDayNormZone = typeof rotationDayNormZones.$inferSelect;
export type NewRotationDayNormZone = typeof rotationDayNormZones.$inferInsert;
export type RotationOccurrence = typeof rotationOccurrences.$inferSelect;
export type NewRotationOccurrence = typeof rotationOccurrences.$inferInsert;
export type RotationAssignment = typeof rotationAssignments.$inferSelect;
export type NewRotationAssignment = typeof rotationAssignments.$inferInsert;
export type RotationDebt = typeof rotationDebts.$inferSelect;
export type NewRotationDebt = typeof rotationDebts.$inferInsert;
export type RotationTemplateSettings = typeof rotationTemplatesSettings.$inferSelect;
export type NewRotationTemplateSettings = typeof rotationTemplatesSettings.$inferInsert;
