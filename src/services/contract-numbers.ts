import { sql } from 'drizzle-orm';

import { lastContractNumber, updateResidency } from '@/db/repositories/residencies';
import { nextContractNumber } from '@/domain/contract-number';
import { todayInAlmaty, type BusinessDate } from '@/lib/time';

import type { AccessContext } from '@/db/access';
import type { Executor } from '@/db/client';
import type { Residency } from '@/db/schema';

/**
 * Номер договора: присваивает система (T8.1, указание владельца).
 *
 * Год берётся по календарю Алматы, как все границы суток в системе.
 */
function yearOf(today: BusinessDate): number {
  return Number(today.slice(0, 4));
}

/**
 * Следующий свободный номер сети.
 *
 * Выдача блокируется на время транзакции: без этого два заселения, ушедшие
 * в базу одновременно, читали максимум до того, как соседнее успевало записать
 * своё, и выбирали один номер. Уникальный индекс превращал это в отказ
 * на ровном месте — приёмки трёх ширин заводят жильцов параллельно, и
 * заведение аккаунта падало без причины, видимой человеку.
 *
 * Блокировка советующая и живёт до конца транзакции: таблицу она не трогает,
 * очередь короткая, а последовательность PostgreSQL дала бы дыры в нумерации
 * при откате. Индекс остаётся последним рубежом.
 */
export async function nextNumberForOrg(
  orgId: string,
  executor: Executor,
  today: BusinessDate = todayInAlmaty(),
): Promise<string> {
  const year = yearOf(today);

  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgId}, ${year}))`);

  return nextContractNumber(await lastContractNumber(orgId, year, executor), year);
}

/**
 * Номер проживания: выданный раньше или выданный сейчас.
 *
 * Проживания, заведённые до появления нумерации, номера не имеют — им он
 * достаётся при первой сборке договора. Задним числом ничего не переписывается:
 * у кого номер есть, тот его и сохраняет.
 */
export async function ensureContractNumber(
  context: AccessContext,
  residency: Residency,
  executor: Executor,
  today: BusinessDate = todayInAlmaty(),
): Promise<string> {
  if (residency.contractNumber !== null && residency.contractNumber !== '') {
    return residency.contractNumber;
  }

  /*
   * Транзакция здесь обязательна: блокировка выдачи живёт до её конца,
   * и без неё номер успел бы уйти второму договору между выбором и записью.
   */
  return executor.transaction(async (tx) => {
    const number = await nextNumberForOrg(context.orgId, tx, today);
    await updateResidency(context, residency.id, { contractNumber: number }, tx);

    return number;
  });
}
