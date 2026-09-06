import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Card } from '@/components/ui/card';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { readOrgSettings } from '@/services/settings';

import { NetworkForm } from './network-form';

export const dynamic = 'force-dynamic';

export default async function NetworkSettingsPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  if (!can(session.context, 'settings.org.read')) {
    // Раздел вне области видимости роли неотличим от несуществующего (P1-1).
    redirect('/settings');
  }

  const t = await getTranslations('settings.network');
  const settings = await readOrgSettings({ context: session.context });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <Card>
        <NetworkForm
          defaultLocale={settings.defaultLocale}
          ratingVisibleToResidents={settings.ratingVisibleToResidents}
        />
      </Card>
    </section>
  );
}
