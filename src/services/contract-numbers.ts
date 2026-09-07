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
 * Уникальность держит индекс `residencies_org_contract_number_unique`:
 * если два заселения уйдут в базу одновременно и получат один номер,
 * второе упадёт с ошибкой — это лучше двух договоров с одним номером.
 */
function yearOf(today: BusinessDate): number {
  return Number(today.slice(0, 4));
}

export async function nextNumberForOrg(
  orgId: string,
  executor: Executor,
  today: BusinessDate = todayInAlmaty(),
): Promise<string> {
  const year = yearOf(today);

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

  const number = await nextNumberForOrg(context.orgId, executor, today);
  await updateResidency(context, residency.id, { contractNumber: number }, executor);

  return number;
}
