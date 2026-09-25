import { AppLink } from '@/components/ui/app-link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { listResidencies } from '@/db/repositories/residencies';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { todayInAlmaty } from '@/lib/time';
import { houseLayout, myPlacement } from '@/services/beds';
import { personLabels } from '@/services/person-labels';
import { listTemporary } from '@/services/temporary-residents';

import { HouseLayout, type RoomView, type UnplacedResident } from './house-layout';
import {
  TemporaryResidents,
  type TemporaryBedOption,
  type TemporaryRowView,
} from './temporary-residents';

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

  /*
   * Имена вместо идентификаторов: схему читает человек. Незаполненный
   * профиль даёт телефон, а не uuid — идентификатор человеку не нужен
   * нигде (указание владельца, 25 сентября 2026).
   */
  const labels = await personLabels(
    context,
    residencies.map((residency) => residency.userId),
  );

  const nameOf = new Map(
    [...labels.values()].map((label) => [label.userId, label.name ?? label.phone]),
  );

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
      name: nameOf.get(residency.userId) ?? '',
    }));

  /*
   * Временные жильцы (T11.3, решение D23): имя и пол на месте, без входа,
   * профиля, денег и рейтинга. Заводятся здесь, потому что временный жилец —
   * это занятость места, а не учётная запись.
   */
  const canTemporary = houseId !== null && can(context, 'temporaryResident.read', { houseId });

  const temporaries: TemporaryRowView[] =
    canTemporary && houseId !== null
      ? (await listTemporary(actor, { houseId })).map((row) => ({
          id: row.id,
          name: row.name,
          sex: row.sex,
          bedLabel: row.bedLabel,
          areaName: row.areaName,
          from: row.period.slice(1, 11),
          to: row.period.length > 13 ? row.period.slice(12, 22) : null,
          note: row.note,
        }))
      : [];

  const temporaryBeds: TemporaryBedOption[] = layout.flatMap((area) =>
    area.beds.map((bed) => ({ bedId: bed.bedId, label: `${area.area.name}, ${bed.label}` })),
  );

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
              <AppLink
                className={house.id === houseId ? 'font-medium' : 'text-accent underline'}
                href={{ pathname: '/beds', query: { house: house.id } }}
                key={house.id}
              >
                {house.name}
              </AppLink>
            ))}
          </div>
        </Card>
      )}

      <HouseLayout rooms={rooms} unplaced={unplaced} />

      {canTemporary && houseId !== null && (
        <TemporaryResidents
          beds={temporaryBeds}
          canWrite={can(context, 'temporaryResident.write', { houseId })}
          houseId={houseId}
          rows={temporaries}
          today={todayInAlmaty()}
        />
      )}
    </section>
  );
}
