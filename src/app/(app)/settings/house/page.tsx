import { AppLink } from '@/components/ui/app-link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { readHouseSetup } from '@/services/house-setup';

import { HouseSetupManager, type AreaRow } from './house-setup-manager';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Настройки дома (docs/04-MODULES/11-users-settings.md, «Настройки дома»).
 *
 * Админ настраивает свой дом; суперадмин выбирает дом ссылкой — сводного
 * экрана по всей сети в модуле 11 нет, и настраивается всегда один дом.
 */
export default async function HouseSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  // Раздел вне области видимости роли неотличим от несуществующего (P1-1).
  if (!can(context, 'settings.house.read', { houseId: context.houseId })) {
    redirect('/settings');
  }

  const t = await getTranslations('houseSetup');
  const actor: UserActor = { context };

  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const { house: requested } = await searchParams;

  const houseId =
    context.role === 'superadmin' ? (requested ?? houses[0]?.id ?? null) : context.houseId;

  if (houseId === null) {
    return (
      <section className="flex flex-col gap-6">
        <h1>{t('title')}</h1>
        <EmptyState description={t('noHouseHint')} title={t('noHouse')} />
      </section>
    );
  }

  const setup = await readHouseSetup(actor, houseId);

  const areas: AreaRow[] = setup.areas.map((area) => ({
    areaId: area.area.id,
    name: area.area.name,
    type: area.area.type,
    sortOrder: area.area.sortOrder,
    beds: area.beds.map((bed) => ({
      bedId: bed.bed.id,
      label: bed.bed.label,
      number: bed.bed.number,
      tier: bed.bed.tier,
      defaultPrice: bed.bed.defaultPrice,
      occupied: bed.occupied,
    })),
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{setup.houseName}</p>
        {/*
          Без параметра `house` и без предзагрузки: раздел сам берёт дом
          из роли, а страница, открытая переходом по предзагруженной ссылке,
          после сохранения показывала прежние данные — ответ брался
          из кеша маршрутизатора, снятого до правки.
        */}
        <AppLink
          className="text-accent text-[13px] underline"
          data-testid="to-rotation-setup"
          href="/settings/house/rotations"
        >
          {t('toRotations')}
        </AppLink>
      </div>

      {houses.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('chooseHouse')}</CardTitle>
          </CardHeader>

          <div className="flex flex-wrap gap-3 text-[13px]">
            {houses.map((house) => (
              <AppLink
                className={house.id === houseId ? 'font-medium' : 'text-accent underline'}
                href={{ pathname: '/settings/house', query: { house: house.id } }}
                key={house.id}
              >
                {house.name}
              </AppLink>
            ))}
          </div>
        </Card>
      )}

      <HouseSetupManager areas={areas} depositDefault={setup.depositDefault} houseId={houseId} />
    </section>
  );
}
