import { AppLink } from '@/components/ui/app-link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/input';
import { monthOptions, parseMonthInput } from '@/domain/utilities';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { addMonths, startOfMonth, todayInAlmaty, type BusinessDate } from '@/lib/time';
import { readProfile } from '@/services/resident-profiles';
import {
  findPeriodOfMonth,
  listPeriodsOfHouse,
  readUtilityHistory,
  readUtilityPeriod,
} from '@/services/utilities';

import { PeriodScreen, type AllocationRowView } from './period-screen';
import { StartPeriod } from './start-period';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Коммунальные услуги (docs/04-MODULES/06-utilities.md).
 *
 * Экран админский: период заполняет тот, кто получил квитанции. Жилец
 * свою долю видит строкой месячного счёта — отдельного экрана коммуналки
 * у него нет (§4).
 *
 * По умолчанию открывается прошлый месяц: коммуналка собирается за него,
 * а заполняют её уже в новом. Любой другой месяц выбирается переключателем
 * или полем выбора месяца — включая текущий и сколь угодно давний.
 */
export default async function UtilitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string; month?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('utilities');
  const { context } = session;
  const actor: UserActor = { context };

  const header = (
    <div className="flex flex-col gap-1">
      <h1>{t('title')}</h1>
      <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
    </div>
  );

  if (context.role === 'resident') {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState description={t('residentHint')} title={t('residentTitle')} />
      </section>
    );
  }

  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const { house: requested, month: requestedMonth } = await searchParams;

  const houseId =
    context.role === 'superadmin' ? (requested ?? houses[0]?.id ?? null) : context.houseId;

  if (houseId === null) {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState description={t('noHouseHint')} title={t('noHouse')} />
      </section>
    );
  }

  const thisMonth = startOfMonth(todayInAlmaty());
  const month = parseMonthInput(requestedMonth ?? '') ?? addMonths(thisMonth, -1);

  const periods = await listPeriodsOfHouse(actor, houseId);

  /*
   * Переключатель показывает заведённые месяцы, текущий и прошлый. Раньше
   * список был вычисляемым — «прошлый и два до него», — и в него никогда
   * не попадал ни текущий месяц, ни что-либо старше трёх месяцев. Месяц
   * вне списка достаётся полем выбора рядом.
   */
  const months = monthOptions(
    thisMonth,
    periods.map((period) => period.month as BusinessDate),
  );

  const period = await findPeriodOfMonth(actor, houseId, month);
  const canManage = can(context, 'utility.manage', { houseId });

  const houseQuery = houses.length > 1 ? { house: houseId } : {};

  const navigation = (
    <div className="flex flex-col gap-3">
      {houses.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-[13px]">
          {houses.map((house) => (
            <AppLink
              className={
                house.id === houseId ? 'text-text font-medium' : 'text-text-muted hover:text-text'
              }
              href={{ pathname: '/utilities', query: { house: house.id, month } }}
              key={house.id}
            >
              {house.name}
            </AppLink>
          ))}
        </nav>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <nav className="flex flex-wrap gap-2 text-[13px]">
          {months.map((value) => (
            <AppLink
              className={
                value === month ? 'text-text font-medium' : 'text-text-muted hover:text-text'
              }
              data-testid="month-link"
              href={{ pathname: '/utilities', query: { month: value, ...houseQuery } }}
              key={value}
            >
              {value.slice(0, 7)}
            </AppLink>
          ))}
        </nav>

        {/* Обычная форма GET: месяц выбирается и без включённого JavaScript. */}
        <form action="/utilities" className="flex items-end gap-2" method="get">
          {houses.length > 1 && <input name="house" type="hidden" value={houseId} />}

          <Field htmlFor="utility-month" label={t('chooseMonth')}>
            <Input
              data-testid="utility-month"
              defaultValue={month.slice(0, 7)}
              id="utility-month"
              name="month"
              type="month"
            />
          </Field>

          <Button size="sm" type="submit" variant="ghost">
            {t('openMonth')}
          </Button>
        </form>
      </div>
    </div>
  );

  if (period === null) {
    return (
      <section className="flex flex-col gap-6">
        {header}
        {navigation}

        {canManage ? (
          <StartPeriod houseId={houseId} month={month} />
        ) : (
          <EmptyState description={t('notStartedHint')} title={t('notStarted')} />
        )}
      </section>
    );
  }

  const [view, history] = await Promise.all([
    readUtilityPeriod(actor, period.id),
    readUtilityHistory(actor, houseId),
  ]);

  const closed = view.period.status === 'closed';
  const source = closed
    ? view.allocations.map((allocation) => ({
        userId: allocation.userId,
        days: allocation.days,
        amount: allocation.amount,
      }))
    : view.preview.allocations;

  /** Имена вместо идентификаторов: распределение читает человек. */
  const rows: AllocationRowView[] = await Promise.all(
    source.map(async (row) => {
      const profile = await readProfile(actor, row.userId);
      const name = [profile.lastName, profile.firstName]
        .filter((part) => part !== null && part !== '')
        .join(' ');

      return {
        userId: row.userId,
        name: name.trim() === '' ? row.userId : name,
        days: row.days,
        amount: row.amount,
      };
    }),
  );

  return (
    <section className="flex flex-col gap-6">
      {header}
      {navigation}

      <PeriodScreen
        canManage={canManage}
        canReopen={can(context, 'utility.reopen', { houseId })}
        closed={closed}
        history={history}
        houseId={houseId}
        lines={view.lines.map((line) => ({
          id: line.id,
          title: line.title,
          amount: line.amount,
          receiptFileId: line.receiptFileId,
        }))}
        month={view.period.month}
        periodId={view.period.id}
        rows={rows}
        surplus={view.preview.surplus}
        total={view.total}
        undistributed={view.preview.undistributed}
      />
    </section>
  );
}
