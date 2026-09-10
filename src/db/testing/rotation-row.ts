import { saveNorm, saveRoster } from '@/services/rotation-day-setup';
import { saveRow } from '@/services/rotation-rows';

import type { Executor } from '@/db/client';
import type { RotationRow } from '@/db/schema';
import type { BusinessDate } from '@/lib/time';
import type { UserActor } from '@/services/users';

/**
 * Помощник интеграционных тестов: ряд вместе с первой версией состава
 * и нормы с даты старта — то, что до фазы 10 делала одна форма ряда.
 *
 * Сами сервисы ряд, состав и норму заводят порознь (P10-17); тестам же
 * почти всегда нужен готовый ряд, чтобы проверить расписание, календарь
 * или дэшборд, а не сборку по частям.
 */
export interface SeedRowInput {
  houseId: string;
  name: string;
  type: 'common' | 'room';
  weekday: number;
  startDate: BusinessDate;
  /** Места состава по порядку позиций. */
  bedIds: readonly string[];
  /** Зоны нормы по порядку; число людей без указания берётся из чек-листа. */
  zones: readonly { areaId: string; checklistId: string; people?: number }[];
}

export async function seedRow(
  actor: UserActor,
  input: SeedRowInput,
  deps: { executor: Executor },
): Promise<RotationRow> {
  const row = await saveRow(
    actor,
    {
      houseId: input.houseId,
      name: input.name,
      type: input.type,
      weekday: input.weekday,
      startDate: input.startDate,
      // Комната комнатного ряда — его единственная зона (§6.4).
      roomAreaId: input.type === 'room' ? (input.zones[0]?.areaId ?? null) : null,
    },
    { executor: deps.executor },
  );

  // «Сегодня» — дата старта: занятий ещё нет, пересобирать нечего,
  // а системные часы в тестах не участвуют.
  await saveRoster(
    actor,
    { rowId: row.id, effectiveFrom: input.startDate, bedIds: input.bedIds },
    { executor: deps.executor, today: input.startDate },
  );
  await saveNorm(
    actor,
    { rowId: row.id, effectiveFrom: input.startDate, zones: input.zones },
    { executor: deps.executor, today: input.startDate },
  );

  return row;
}
