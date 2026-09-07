import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { ModuleStub } from '@/components/layout/module-stub';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/lib/i18n/config';
import { getCurrentSession } from '@/lib/session';
import { readResidentDashboard } from '@/services/dashboard';
import { readOnboarding } from '@/services/onboarding';
import { readTerminationView } from '@/services/terminations';

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
export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('home');

  if (session.context.role !== 'resident') {
    return <ModuleStub navKey="dashboard" />;
  }

  const { context } = session;
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
