import { getTranslations } from 'next-intl/server';

import { AppLink } from '@/components/ui/app-link';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';

import { HoleDecisions } from './hole-decisions';

import type { HouseDashboard } from '@/services/dashboard';

/**
 * Дэшборд админа дома (docs/04-MODULES/09-dashboards.md, «Админ дома»).
 *
 * Экран показывает: ротации дня правятся в календаре, счета — в счетах,
 * коммуналка — в коммуналке. Единственное исключение — дырки расписания
 * в «Требует решения»: варианты для них система считает именно здесь
 * (план фазы 10 §2.8), и выбор из них — та же правка недели, что в календаре.
 */
const STATE_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  confirmed: 'success',
  assigned: 'neutral',
  needs_reassignment: 'warning',
  missed: 'danger',
  cancelled: 'neutral',
};

export async function HouseDashboardView({ view }: { view: HouseDashboard }) {
  const t = await getTranslations('home.admin');
  /* «Никто» уже переведено в календаре: пустой слот там называется так же. */
  const tCalendar = await getTranslations('rotationCalendar');
  const month = view.money.month.slice(0, 7);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card data-testid="card-today">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>

        {view.cleanings.length === 0 ? (
          <EmptyState title={t('noCleanings')} />
        ) : (
          <ul className="flex flex-col gap-3">
            {view.cleanings.map((cleaning) => (
              <li className="flex flex-col gap-1" key={cleaning.occurrenceId}>
                <span className="text-[15px] font-medium">
                  {cleaning.areaName} · {cleaning.checklistTitle}
                </span>
                <div className="flex flex-wrap gap-2">
                  {cleaning.workers.map((worker) => (
                    <Badge key={worker.assignmentId} tone={STATE_TONE[worker.state] ?? 'neutral'}>
                      {worker.name === '' ? tCalendar('nobody') : worker.name}
                    </Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}

        <AppLink className="text-accent mt-3 inline-block text-[13px] underline" href="/rotations">
          {t('openCalendar')}
        </AppLink>
      </Card>

      <Card data-testid="card-decisions">
        <CardHeader>
          <CardTitle>{t('decisions')}</CardTitle>
        </CardHeader>

        {view.decisions.length === 0 && view.holes.length === 0 ? (
          <p className="text-text-muted text-[13px]">{t('noDecisions')}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {view.holes.length > 0 && <HoleDecisions holes={view.holes} />}

            {view.decisions.length > 0 && (
              <ul className="flex flex-col gap-2">
                {view.decisions.map((decision) => (
                  <li className="flex flex-wrap items-center gap-2" key={decision.assignmentId}>
                    <Badge tone={decision.kind === 'needs_reassignment' ? 'warning' : 'danger'}>
                      {decision.kind === 'needs_reassignment'
                        ? t('needsReassignment')
                        : t('unconfirmed', { date: decision.date })}
                    </Badge>
                    <span className="text-[13px]">
                      {decision.areaName}
                      {decision.name === null ? '' : ` · ${decision.name}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card data-testid="card-money">
        <CardHeader>
          <CardTitle>{t('money', { month })}</CardTitle>
        </CardHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-muted text-[13px]">{t('issued')}</span>
            <Money amount={view.money.issued} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-muted text-[13px]">{t('paid')}</span>
            <Money amount={view.money.paid} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-muted text-[13px]">{t('debt')}</span>
            <Money amount={view.money.debt} />
          </div>

          <p className="text-text-muted text-[13px]">
            {t('remote', { count: view.money.remoteTasks })}
          </p>

          <span className="text-[13px] font-medium">{t('debtors')}</span>
          {view.money.debtors.length === 0 ? (
            <p className="text-text-muted text-[13px]">{t('noDebtors')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {view.money.debtors.map((debtor) => (
                <li className="flex items-center justify-between gap-3" key={debtor.residencyId}>
                  <span className="text-[13px]">{debtor.name}</span>
                  <Money amount={debtor.remaining} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card data-testid="card-house-rating">
        <CardHeader>
          <CardTitle>{t('ratingTitle')}</CardTitle>
        </CardHeader>

        {view.rating.average === null ? (
          <p className="text-text-muted text-[13px]">{t('noRating')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-muted text-[13px]">{t('average')}</span>
              <span className="tabular text-[20px] font-semibold">{view.rating.average}</span>
            </div>

            <span className="text-[13px] font-medium">{t('best')}</span>
            <ul className="flex flex-col gap-1">
              {view.rating.best.map((row) => (
                <li className="flex items-center justify-between gap-3" key={`best-${row.userId}`}>
                  <span className="text-[13px]">{row.name}</span>
                  <span className="tabular text-[13px]">{row.rating}</span>
                </li>
              ))}
            </ul>

            <span className="text-[13px] font-medium">{t('worst')}</span>
            <ul className="flex flex-col gap-1">
              {view.rating.worst.map((row) => (
                <li className="flex items-center justify-between gap-3" key={`worst-${row.userId}`}>
                  <span className="text-[13px]">{row.name}</span>
                  <span className="tabular text-[13px]">{row.rating}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card data-testid="card-utilities">
        <CardHeader>
          <CardTitle>{t('utilitiesTitle', { month })}</CardTitle>
        </CardHeader>

        <div className="flex flex-col items-start gap-2">
          <Badge tone={view.utilities.status === 'closed' ? 'success' : 'warning'}>
            {view.utilities.status === 'closed'
              ? t('utilitiesClosed')
              : view.utilities.status === 'draft'
                ? t('utilitiesDraft')
                : t('utilitiesMissing')}
          </Badge>
          <AppLink className="text-accent text-[13px] underline" href="/utilities">
            {t('utilitiesTitle', { month })}
          </AppLink>
        </div>
      </Card>

      <Card data-testid="card-onboarding">
        <CardHeader>
          <CardTitle>{t('onboardingTitle')}</CardTitle>
        </CardHeader>

        <div className="flex flex-col gap-2">
          {view.onboarding.moveIn.length === 0 ? (
            <p className="text-text-muted text-[13px]">{t('onboardingEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {view.onboarding.moveIn.map((entry) => (
                <li className="flex items-center justify-between gap-3" key={entry.residencyId}>
                  <span className="text-[13px]">{entry.name}</span>
                  <Badge tone="warning">{entry.status}</Badge>
                </li>
              ))}
            </ul>
          )}

          <p className="text-text-muted text-[13px]">
            {t('expiringDocuments', { count: view.onboarding.documents })}
          </p>
        </div>
      </Card>
    </div>
  );
}
