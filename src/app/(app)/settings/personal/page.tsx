import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentSession } from '@/lib/session';

import { PersonalForm } from './personal-form';

export const dynamic = 'force-dynamic';

export default async function PersonalSettingsPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations();

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('settings.personal.title')}</h1>
        <p className="text-text-muted text-[13px]">{t('settings.personal.subtitle')}</p>
      </div>

      <Card>
        <PersonalForm locale={session.user.locale} theme={session.user.theme} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('auth.changePassword.title')}</CardTitle>
        </CardHeader>
        <Link className="text-primary text-[15px] hover:underline" href="/change-password">
          {t('settings.personal.changePassword')}
        </Link>
      </Card>
    </section>
  );
}
