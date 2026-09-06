import { redirect } from 'next/navigation';

import { ModuleStub } from '@/components/layout/module-stub';
import { getCurrentSession } from '@/lib/session';
import { readOnboarding } from '@/services/onboarding';

import { OnboardingWizard } from './onboarding-wizard';

export const dynamic = 'force-dynamic';

/**
 * Дэшборд. Пока жилец не заселён, здесь стоит мастер заселения (§1.2):
 * остальные модули ему всё равно закрыты, и показывать их заглушки —
 * значит предлагать то, чего нельзя открыть.
 */
export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  if (session.context.role !== 'resident') {
    return <ModuleStub navKey="dashboard" />;
  }

  const onboarding = await readOnboarding({ context: session.context });

  if (!onboarding.isBlocked) {
    return <ModuleStub navKey="dashboard" />;
  }

  return (
    <section className="flex flex-col gap-6">
      <OnboardingWizard steps={onboarding.steps} />
    </section>
  );
}
