import { ACCOUNT_CODES, accounts, houseFundCode } from '../schema';

import type { Executor } from '../client';

/**
 * План счетов для интеграционных тестов — тот же набор, что заводит сид
 * (`src/db/seed.ts`) и заведение дома.
 *
 * Нужен почти каждой денежной фикстуре: без депозитного фонда и фонда дома
 * оплата, ущерб и сгорание депозита падают — и падают правильно, деньги мимо
 * книги проводок не проходят. Россыпь одинаковых вставок в каждом файле
 * разъехалась бы с сидом при первом же новом счёте.
 *
 * Модуль нужен только тестам: приложение заводит счета сидом.
 */
export async function seedChartOfAccounts(
  executor: Executor,
  orgId: string,
  houses: readonly { id: string; slug: string; name?: string }[] = [],
): Promise<void> {
  await executor.insert(accounts).values([
    { orgId, code: ACCOUNT_CODES.depositFund, name: 'Депозитный фонд', type: 'deposit_fund' },
    { orgId, code: ACCOUNT_CODES.utilityFund, name: 'Коммунальный фонд', type: 'utility_fund' },
    { orgId, code: ACCOUNT_CODES.commonFund, name: 'Общий счёт', type: 'common_fund' },
    { orgId, code: ACCOUNT_CODES.cash, name: 'Касса', type: 'cash' },
    { orgId, code: ACCOUNT_CODES.kaspi, name: 'Kaspi', type: 'kaspi' },
    ...houses.map((house) => ({
      orgId,
      houseId: house.id,
      code: houseFundCode(house.slug),
      name: `Фонд дома: ${house.name ?? house.slug}`,
      type: 'house_fund' as const,
    })),
  ]);
}
