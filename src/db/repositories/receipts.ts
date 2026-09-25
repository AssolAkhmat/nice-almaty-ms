import { and, eq, inArray } from 'drizzle-orm';

import { getDb, type Executor } from '../client';
import { damages, damageShares, residencies, utilityLines, utilityPeriods } from '../schema';

/**
 * К чему приложен чек и виден ли он жильцу (указание владельца,
 * 25 сентября 2026).
 *
 * Жилец видит в депозите списание за ущерб и в счёте строку коммуналки,
 * а приложенный админом чек ему был недоступен. Это расходы дома, а не
 * персональные данные других жильцов, поэтому чек ему показывается —
 * но по-прежнему не любой:
 *
 * - чек ущерба — если у жильца есть доля в этом ущербе (модуль 7: он видит
 *   все списания депозита за год, значит и основание списания);
 * - чек коммуналки — если период **закрыт** и относится к дому, где у жильца
 *   есть или было проживание. Открытый период ещё меняется, и показывать
 *   его чеки как основание расчёта рано.
 *
 * Чек расхода сети (`expense-receipt`) сюда не попадает: он ни к ущербу,
 * ни к коммунальному периоду не привязан, и жильца не касается.
 */
export type ReceiptVisibility =
  { kind: 'damage'; visible: boolean } | { kind: 'utility'; visible: boolean } | { kind: 'none' };

export async function receiptVisibleToResident(
  fileId: string,
  userId: string,
  executor: Executor = getDb(),
): Promise<ReceiptVisibility> {
  const [damage] = await executor
    .select({ id: damages.id })
    .from(damages)
    .where(eq(damages.receiptFileId, fileId))
    .limit(1);

  if (damage !== undefined) {
    const [share] = await executor
      .select({ id: damageShares.id })
      .from(damageShares)
      .where(and(eq(damageShares.damageId, damage.id), eq(damageShares.userId, userId)))
      .limit(1);

    return { kind: 'damage', visible: share !== undefined };
  }

  const [line] = await executor
    .select({ periodId: utilityLines.periodId })
    .from(utilityLines)
    .where(eq(utilityLines.receiptFileId, fileId))
    .limit(1);

  if (line === undefined) {
    return { kind: 'none' };
  }

  /* Дома жильца: нынешний и прошлые — переселившийся платил и старому (D26). */
  const houses = executor
    .select({ id: residencies.houseId })
    .from(residencies)
    .where(eq(residencies.userId, userId));

  const [period] = await executor
    .select({ id: utilityPeriods.id })
    .from(utilityPeriods)
    .where(
      and(
        eq(utilityPeriods.id, line.periodId),
        eq(utilityPeriods.status, 'closed'),
        inArray(utilityPeriods.houseId, houses),
      ),
    )
    .limit(1);

  return { kind: 'utility', visible: period !== undefined };
}
