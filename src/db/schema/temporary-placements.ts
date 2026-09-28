import { sql } from 'drizzle-orm';
import { customType, foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { beds } from './beds';
import { houses } from './houses';
import { organizations } from './organizations';
import { residencies } from './residencies';
import { users } from './users';

/** Полуоткрытый интервал дат `[начало, конец)`, как у назначений мест. */
const daterange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'daterange';
  },
});

/**
 * Временное размещение жильца (указание владельца, 27 сентября 2026, P1-5).
 *
 * Ремонт, авария, конфликт: человек физически живёт в другом месте, а
 * расчётное место остаётся за ним. Поэтому это **не** назначение места:
 * `bed_assignments` не трогается вовсе — цена, человеко-дни коммуналки,
 * ротации и привязка прошлого ущерба остаются прежними, а акты
 * не переоформляются.
 *
 * Отдельная таблица, а не поле в проживании: размещений бывает несколько
 * подряд, и у каждого свои даты и причина. Причина обязательна — «почему
 * человек не там, где по документам» и есть смысл записи.
 */
export const temporaryPlacements = pgTable(
  'temporary_placements',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    residencyId: uuid('residency_id')
      .notNull()
      .references(() => residencies.id),
    houseId: uuid('house_id')
      .notNull()
      .references(() => houses.id),
    bedId: uuid('bed_id')
      .notNull()
      .references(() => beds.id),
    period: daterange('period').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('temporary_placements_residency_idx').on(table.residencyId),
    index('temporary_placements_bed_idx').on(table.bedId),
    /* Место — только своего дома, тем же составным ключом, что у временных жильцов. */
    foreignKey({
      columns: [table.bedId, table.houseId],
      foreignColumns: [beds.id, beds.houseId],
      name: 'temporary_placements_bed_house_fk',
    }),
  ],
);

export type TemporaryPlacement = typeof temporaryPlacements.$inferSelect;
export type NewTemporaryPlacement = typeof temporaryPlacements.$inferInsert;
