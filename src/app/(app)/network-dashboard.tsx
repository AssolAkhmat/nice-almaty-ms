import { getTranslations } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';

import type { NetworkDashboard } from '@/services/dashboard';

/**
 * Дэшборд суперадмина (docs/04-MODULES/09-dashboards.md, «Суперадмин»).
 *
 * Сеть построчно: дом, занятость мест, деньги месяца, рейтинг и средняя
 * оценка уборок. Строками, а не таблицей: колонок шесть, и на телефоне
 * таблица потребовала бы горизонтальной прокрутки, которой в системе нет.
 * Дальше — возвраты депозитов с обратным отсчётом и то, что ждёт решения
 * именно суперадмина: скидки система предлагает, подтверждает он.
 */
export async function NetworkDashboardView({ view }: { view: NetworkDashboard }) {
  const t = await getTranslations('home.network');
  const month = view.month.slice(0, 7);

  return (
    <div className="flex flex-col gap-4">
      <Card data-testid="card-network">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>

        {view.houses.length === 0 ? (
          <EmptyState title={t('noHouses')} />
        ) : (
          <ul className="flex flex-col gap-3">
            {view.houses.map((house) => (
              <li className="flex flex-col gap-1" key={house.houseId}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[15px] font-medium">{house.name}</span>
                  <span className="tabular text-text-muted text-[13px]">
                    {t('beds')}: {house.beds.taken}/{house.beds.total}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
                  <span className="text-text-muted">{t('issued')}</span>
                  <Money amount={house.issued} />
                  <span className="text-text-muted">{t('paid')}</span>
                  <Money amount={house.paid} />
                  <span className="text-text-muted">{t('debt')}</span>
                  <Money amount={house.debt} />
                  <span className="text-text-muted">{t('rating')}</span>
                  <span className="tabular">{house.rating ?? '—'}</span>
                  <span className="text-text-muted">{t('cleaning')}</span>
                  <span className="tabular">{house.cleaningScore ?? '—'}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="text-text-muted mt-3 text-[13px]">{t('money', { month })}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card data-testid="card-refunds">
          <CardHeader>
            <CardTitle>{t('refunds')}</CardTitle>
          </CardHeader>

          {view.refunds.length === 0 ? (
            <p className="text-text-muted text-[13px]">{t('noRefunds')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {view.refunds.map((refund) => (
                <li className="flex flex-wrap items-center gap-2" key={refund.residencyId}>
                  <Badge tone={refund.daysLeft < 0 ? 'danger' : 'warning'}>
                    {refund.daysLeft < 0
                      ? t('overdue', { days: -refund.daysLeft })
                      : t('daysLeft', { days: refund.daysLeft })}
                  </Badge>
                  <span className="text-[13px]">{refund.houseName}</span>
                  <span className="tabular text-text-muted text-[13px]">{refund.deadline}</span>
                  <Money amount={refund.balance} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card data-testid="card-network-decisions">
          <CardHeader>
            <CardTitle>{t('decisions')}</CardTitle>
          </CardHeader>

          {view.decisions.discounts === 0 &&
          view.decisions.fines === 0 &&
          view.decisions.utilityPeriods.length === 0 ? (
            <p className="text-text-muted text-[13px]">{t('noDecisions')}</p>
          ) : (
            <ul className="flex flex-col gap-2 text-[13px]">
              <li>{t('discounts', { count: view.decisions.discounts })}</li>
              <li>{t('fines', { count: view.decisions.fines })}</li>
              <li>{t('periods', { count: view.decisions.utilityPeriods.length })}</li>
              {view.decisions.utilityPeriods.map((period) => (
                <li className="text-text-muted" key={period.periodId}>
                  {period.houseName} · {period.month.slice(0, 7)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
