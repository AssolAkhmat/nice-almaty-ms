import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { listResidencies } from '@/db/repositories/residencies';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { getCurrentSession } from '@/lib/session';
import { houseLayout, myPlacement } from '@/services/beds';
import { readProfile } from '@/services/resident-profiles';

import { HouseLayout, type RoomView, type UnplacedResident } from './house-layout';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Места (docs/04-MODULES/01-onboarding.md, §1.2 п.4).
 *
 * Админ видит схему своего дома с занятостью и назначает места. Жилец видит
 * только своё место: схема дома — рабочий инструмент админа, а не общий вид.
 */
export default async function BedsPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('beds');
  const { context } = session;
  const actor: UserActor = { context };

  const isAdmin = context.role === 'admin' || context.role === 'superadmin';

  if (!isAdmin) {
    const [residency] = await listResidencies(context, {});
    const placement = residency === undefined ? null : await myPlacement(actor, residency.id);

    return (
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1>{t('title')}</h1>
          <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
        </div>

        {placement === null ? (
          <EmptyState description={t('noPlacementHint')} title={t('noPlacement')} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{placement.area.name}</CardTitle>
              <Money amount={placement.price} />
            </CardHeader>
            <p className="p-4 pt-0 text-[13px]">{placement.bed.label}</p>
          </Card>
        )}
      </section>
    );
  }

  /*
   * Суперадмин не привязан к дому: схему он открывает по конкретному дому,
   * а сводного экрана по всей сети в модуле 1 нет. Дом выбирается ссылкой —
   * это обещанное в P2-26 продолжение, появившееся вместе с настройкой зон.
   */
  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const { house: requested } = await searchParams;

  const houseId =
    context.role === 'superadmin' ? (requested ?? houses[0]?.id ?? null) : context.houseId;

  const residencies = await listResidencies(context, houseId === null ? {} : { houseId });

  const layout = houseId === null ? [] : await houseLayout(actor, houseId);

  /** Имена показываются вместо идентификаторов: схему читает человек. */
  const nameOf = new Map<string, string>();
  for (const residency of residencies) {
    const profile = await readProfile(actor, residency.userId);
    const name = [profile.lastName, profile.firstName]
      .filter((part) => part !== null && part !== '')
      .join(' ');
    nameOf.set(residency.userId, name.trim() === '' ? residency.userId : name);
  }

  const rooms: RoomView[] = layout.map((area) => ({
    areaId: area.area.id,
    name: area.area.name,
    beds: area.beds.map((bed) => ({
      bedId: bed.bedId,
      label: bed.label,
      defaultPrice: bed.defaultPrice,
      occupantName:
        bed.occupiedBy === null
          ? null
          : (nameOf.get(bed.occupiedBy.userId) ?? bed.occupiedBy.userId),
      occupantPrice: bed.occupiedBy?.price ?? null,
    })),
  }));

  const placedResidencies = new Set(
    layout.flatMap((area) =>
      area.beds
        .filter((bed) => bed.occupiedBy !== null)
        .map((bed) => bed.occupiedBy?.residencyId ?? ''),
    ),
  );

  const unplaced: UnplacedResident[] = residencies
    .filter((residency) => !placedResidencies.has(residency.id))
    .map((residency) => ({
      residencyId: residency.id,
      name: nameOf.get(residency.userId) ?? residency.userId,
    }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('adminSubtitle')}</p>
      </div>

      {houses.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('chooseHouse')}</CardTitle>
          </CardHeader>

          <div className="flex flex-wrap gap-3 text-[13px]">
            {houses.map((house) => (
              <Link
                className={house.id === houseId ? 'font-medium' : 'text-accent underline'}
                href={{ pathname: '/beds', query: { house: house.id } }}
                key={house.id}
              >
                {house.name}
              </Link>
            ))}
          </div>
        </Card>
      )}

      <HouseLayout rooms={rooms} unplaced={unplaced} />
    </section>
  );
}
