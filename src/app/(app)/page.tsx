import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { ModuleStub } from '@/components/layout/module-stub';
import { AppLink } from '@/components/ui/app-link';
import { listHouses } from '@/db/repositories/houses';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/lib/i18n/config';
import { getCurrentSession } from '@/lib/session';
import { readHouseDashboard, readResidentDashboard } from '@/services/dashboard';
import { readOnboarding } from '@/services/onboarding';
import { readTerminationView } from '@/services/terminations';

import { HouseDashboardView } from './house-dashboard';
import { OnboardingWizard } from './onboarding-wizard';
import { ResidentDashboard } from './resident-dashboard';
import { TerminationNotice } from './termination-notice';

/** Название документа хранится на трёх языках: выбирает читающий. */
function textIn(value: unknown, locale: Locale): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }

  const texts = value as Partial<Record<Locale, string>>;

  return texts[locale] ?? texts[DEFAULT_LOCALE] ?? '';
}

export const dynamic = 'force-dynamic';

/**
 * Дэшборд. Пока жилец не заселён, здесь стоит мастер заселения (§1.2):
 * остальные модули ему всё равно закрыты, и показывать их заглушки —
 * значит предлагать то, чего нельзя открыть. После расторжения на том же
 * месте стоит сводка выселения: мастер заселения там был бы ложью.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('home');
  const { context } = session;

  /*
   * Дом админа — свой; суперадмин выбирает, как и на остальных экранах,
   * и в доме без админа дэшборд ведёт он же (P6-17).
   */
  if (session.context.role !== 'resident') {
    const houses = context.role === 'superadmin' ? await listHouses(context) : [];
    const requested = (await searchParams).house;
    const houseId =
      context.role === 'superadmin' ? (requested ?? houses[0]?.id ?? null) : context.houseId;

    if (houseId === null) {
      return <ModuleStub navKey="dashboard" />;
    }

    const view = await readHouseDashboard({ context }, houseId);

    return (
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1>{t('title')}</h1>
          <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
        </div>

        {houses.length > 1 && (
          <nav className="flex flex-wrap gap-2 text-[13px]">
            {houses.map((house) => (
              <AppLink
                className={
                  house.id === houseId ? 'text-text font-medium' : 'text-text-muted hover:text-text'
                }
                data-testid={`house-${house.id}`}
                href={{ pathname: '/', query: { house: house.id } }}
                key={house.id}
              >
                {house.name}
              </AppLink>
            ))}
          </nav>
        )}

        <HouseDashboardView view={view} />
      </section>
    );
  }

  const onboarding = await readOnboarding({ context });

  if (onboarding.scope === 'full') {
    const view = await readResidentDashboard({ context });

    if (view === null) {
      return <ModuleStub navKey="dashboard" />;
    }

    const rawLocale = await getLocale();
    const locale: Locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

    return (
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1>{t('title')}</h1>
          <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
        </div>

        <ResidentDashboard
          attention={{
            documents: view.attention.documents.map((document) => ({
              title: textIn(document.title, locale),
              reason: document.reason,
              daysLeft: document.daysLeft,
            })),
            steps: view.attention.steps,
          }}
          cleaning={view.nextCleaning}
          deposit={view.deposit}
          invoice={view.invoice}
          rating={view.rating}
        />
      </section>
    );
  }

  if (onboarding.scope === 'termination' && onboarding.residency !== null) {
    const view = await readTerminationView({ context }, onboarding.residency.id);

    return (
      <section className="flex flex-col gap-6">
        <TerminationNotice
          balance={view.balance}
          daysLeft={view.daysLeft}
          deadline={view.deadline}
          moveOutDate={view.residency.moveOutDate}
          refundStatus={view.refundInvoice?.status ?? null}
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <OnboardingWizard steps={onboarding.steps} />
    </section>
  );
}
