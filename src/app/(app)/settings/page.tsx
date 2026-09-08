import { AppLink } from '@/components/ui/app-link';
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
            <AppLink className="text-primary hover:underline" href="/settings/users">
              {t('users.title')}
            </AppLink>
          </CardTitle>
          <p className="text-text-muted mt-1 text-[13px]">{t('users.subtitle')}</p>
        </Card>
      ) : null}

      {can(session.context, 'house.read', { houseId: session.context.houseId }) ||
      can(session.context, 'house.create') ? (
        <Card>
          <CardTitle>
            <AppLink className="text-primary hover:underline" href="/settings/houses">
              {t('houses.title')}
            </AppLink>
          </CardTitle>
          <p className="text-text-muted mt-1 text-[13px]">{t('houses.subtitle')}</p>
        </Card>
      ) : null}

      {can(session.context, 'settings.house.read', { houseId: session.context.houseId }) ? (
        <Card>
          <CardTitle>
            <AppLink className="text-primary hover:underline" href="/settings/house">
              {t('houseSetup.title')}
            </AppLink>
          </CardTitle>
          <p className="text-text-muted mt-1 text-[13px]">{t('houseSetup.subtitle')}</p>
        </Card>
      ) : null}

      {can(session.context, 'settings.org.read') ? (
        <Card>
          <CardTitle>
            <AppLink className="text-primary hover:underline" href="/settings/network">
              {t('settings.network.title')}
            </AppLink>
          </CardTitle>
          <p className="text-text-muted mt-1 text-[13px]">{t('settings.network.subtitle')}</p>
        </Card>
      ) : null}

      {can(session.context, 'settings.org.read') ? (
        <Card>
          <CardTitle>
            <AppLink className="text-primary hover:underline" href="/settings/document-types">
              {t('documentTypes.title')}
            </AppLink>
          </CardTitle>
          <p className="text-text-muted mt-1 text-[13px]">{t('documentTypes.subtitle')}</p>
        </Card>
      ) : null}

      {can(session.context, 'rating.rules') ? (
        <Card>
          <CardTitle>
            <AppLink className="text-primary hover:underline" href="/settings/rating">
              {t('rating.rules.title')}
            </AppLink>
          </CardTitle>
          <p className="text-text-muted mt-1 text-[13px]">{t('rating.rules.subtitle')}</p>
        </Card>
      ) : null}

      {can(session.context, 'settings.org.read', {}) ? (
        <Card>
          <CardTitle>
            <AppLink className="text-primary hover:underline" href="/settings/api-tokens">
              {t('apiTokens.title')}
            </AppLink>
          </CardTitle>
          <p className="text-text-muted mt-1 text-[13px]">{t('apiTokens.subtitle')}</p>
        </Card>
      ) : null}

      {can(session.context, 'audit.read') ? (
        <Card>
          <CardTitle>
            <AppLink className="text-primary hover:underline" href="/settings/audit">
              {t('audit.title')}
            </AppLink>
          </CardTitle>
          <p className="text-text-muted mt-1 text-[13px]">{t('audit.subtitle')}</p>
        </Card>
      ) : null}

      <Card>
        <CardTitle>
          <AppLink className="text-primary hover:underline" href="/profile">
            {t('profile.title')}
          </AppLink>
        </CardTitle>
        <p className="text-text-muted mt-1 text-[13px]">{t('profile.subtitle')}</p>
      </Card>

      <Card>
        <CardTitle>
          <AppLink className="text-primary hover:underline" href="/settings/personal">
            {t('settings.personal.title')}
          </AppLink>
        </CardTitle>
        <p className="text-text-muted mt-1 text-[13px]">{t('settings.personal.subtitle')}</p>
      </Card>
    </section>
  );
}
