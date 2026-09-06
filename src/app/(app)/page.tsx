import { redirect } from 'next/navigation';

import { ModuleStub } from '@/components/layout/module-stub';
import { getCurrentSession } from '@/lib/session';
import { readOnboarding } from '@/services/onboarding';
import { readTerminationView } from '@/services/terminations';

import { OnboardingWizard } from './onboarding-wizard';
import { TerminationNotice } from './termination-notice';

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

  if (session.context.role !== 'resident') {
    return <ModuleStub navKey="dashboard" />;
  }

  const { context } = session;
  const onboarding = await readOnboarding({ context });

  if (onboarding.scope === 'full') {
    return <ModuleStub navKey="dashboard" />;
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
