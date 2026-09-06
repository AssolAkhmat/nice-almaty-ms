import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Card, CardTitle } from '@/components/ui/card';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations();

  return (
    <section className="flex flex-col gap-4">
      <h1>{t('nav.settings')}</h1>

      {can(session.context, 'user.read', {
        houseId: session.context.houseId,
        userId: session.context.userId,
      }) ? (
        <Card>
          <CardTitle>
            <Link className="text-primary hover:underline" href="/settings/users">
              {t('users.title')}
            </Link>
          </CardTitle>
          <p className="text-text-muted mt-1 text-[13px]">{t('users.subtitle')}</p>
        </Card>
      ) : null}
    </section>
  );
}
