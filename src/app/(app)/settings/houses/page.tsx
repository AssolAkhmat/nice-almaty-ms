import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { listHousesForActor } from '@/services/houses';

import { HousesManager, type HouseRow } from './houses-manager';

export const dynamic = 'force-dynamic';

export default async function HousesPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('houses');
  const { context } = session;

  const houses = await listHousesForActor({ context });

  const rows: HouseRow[] = houses.map((house) => ({
    id: house.id,
    name: house.name,
    slug: house.slug,
    address: house.address,
    curfewTime: house.curfewTime,
    defaultDeposit: house.defaultDeposit,
    isArchived: house.archivedAt !== null,
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <HousesManager canManage={can(context, 'house.create')} rows={rows} />
    </section>
  );
}
