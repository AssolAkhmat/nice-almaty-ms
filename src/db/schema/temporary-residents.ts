import { sql } from 'drizzle-orm';
import { customType, foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { beds } from './beds';
import { houses } from './houses';
import { organizations } from './organizations';
import { sexEnum } from './resident-profiles';
import { users } from './users';

/** Полуоткрытый интервал дат: `[начало, конец)`. Строится в `src/db/period.ts`. */
const daterange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'daterange';
  },
});

/**
 * Временный жилец: имя и пол, привязанные к месту на период
 * (указание владельца, 21 сентября 2026; переходный период, пока не все
 * жильцы заведены в систему, а расписание нужно строить уже сейчас).
 *
 * Это не пользователь: входа в систему, профиля, документов, депозита,
 * счетов, коммуналки и рейтинга у него нет и не будет. Он существует ровно
 * затем, чтобы ряд ротаций был полным: модель фазы 10 привязана к месту
 * (D12), поэтому сетка от него не меняется.
 *
 * Пол — обязательный. Без него не работают предустановленные фильтры
 * допуска «парни» и «девушки» (`src/domain/eligibility.ts`): проверка там
 * строгая, и `null` не проходит ни в одну из групп. Комнату даёт само место,
 * поэтому фильтр «жильцы комнаты» работает и так.
 *
 * Ограничения — в рукописной части миграции: пересечение периодов на одном
 * месте и пересечение с настоящим проживанием запрещены на уровне базы,
 * а не проверкой в сервисе.
 */
export const temporaryResidents = pgTable(
  'temporary_residents',
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
    bedId: uuid('bed_id')
      .notNull()
      .references(() => beds.id),
    name: text('name').notNull(),
    /** Обязателен: на нём держатся фильтры допуска «парни» и «девушки». */
    sex: sexEnum('sex').notNull(),
    period: daterange('period').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('temporary_residents_house_idx').on(table.houseId),
    index('temporary_residents_bed_idx').on(table.bedId),
    /*
     * Место — только своего дома. Тот же приём, что у зоны инвентаря (D22):
     * составной ключ отвергает чужое место сам, без проверки в сервисе.
     */
    foreignKey({
      columns: [table.bedId, table.houseId],
      foreignColumns: [beds.id, beds.houseId],
      name: 'temporary_residents_bed_house_fk',
    }),
  ],
);

export type TemporaryResident = typeof temporaryResidents.$inferSelect;
export type NewTemporaryResident = typeof temporaryResidents.$inferInsert;
