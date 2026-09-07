import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { listAreas } from '@/db/repositories/areas';
import { listHouses } from '@/db/repositories/houses';
import { listHouseRoster } from '@/db/repositories/residencies';
import { EmptyState } from '@/components/ui/empty-state';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { listHouseDamages } from '@/services/damages';
import { readProfile } from '@/services/resident-profiles';

import { DamagesManager, type DamageView, type RosterView } from './damages-manager';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Ущерб (docs/04-MODULES/07-damages.md).
 *
 * Экран админский: заводит ущерб тот, кто видел поломку. Жилец сюда
 * не заходит — свои списания он читает в движении депозита, и это
 * единственный источник, который ему нужен (§8).
 */
export default async function DamagesPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('damages');
  const { context } = session;
  const actor: UserActor = { context };

  const header = (
    <div className="flex flex-col gap-1">
      <h1>{t('title')}</h1>
      <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
    </div>
  );

  if (context.role === 'resident') {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState description={t('residentHint')} title={t('residentTitle')} />
      </section>
    );
  }

  /*
   * Суперадмин не привязан к дому: ущерб он открывает по конкретному дому.
   * Дом выбирается ссылкой — так же, как на схеме мест (P2-26).
   */
  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const { house: requested } = await searchParams;

  const houseId =
    context.role === 'superadmin' ? (requested ?? houses[0]?.id ?? null) : context.houseId;

  if (houseId === null) {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState description={t('noHouseHint')} title={t('noHouse')} />
      </section>
    );
  }

  const [roster, areas, damages] = await Promise.all([
    listHouseRoster(context, houseId),
    listAreas(context, houseId),
    listHouseDamages(actor, houseId),
  ]);

  /** Имена вместо идентификаторов: деление ущерба читает человек. */
  const nameOf = new Map<string, string>();
  for (const entry of roster) {
    const profile = await readProfile(actor, entry.userId);
    const name = [profile.lastName, profile.firstName]
      .filter((part) => part !== null && part !== '')
      .join(' ');
    nameOf.set(entry.userId, name.trim() === '' ? entry.userId : name);
  }

  const rosterView: RosterView[] = roster.map((entry) => ({
    userId: entry.userId,
    name: nameOf.get(entry.userId) ?? entry.userId,
    areaId: entry.areaId,
  }));

  const damageViews: DamageView[] = damages.map((row) => ({
    id: row.damage.id,
    title: row.damage.title,
    description: row.damage.description,
    amount: row.damage.amount,
    surplus: row.damage.surplus,
    splitMode: row.damage.splitMode,
    createdAt: row.damage.createdAt.toISOString(),
    reversed: row.damage.reversedAt !== null,
    receiptFileId: row.damage.receiptFileId,
    shares: row.shares.map((share) => ({
      userId: share.userId,
      name: nameOf.get(share.userId) ?? share.userId,
      amount: share.amount,
    })),
  }));

  return (
    <section className="flex flex-col gap-6">
      {header}

      {houses.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-[13px]">
          {houses.map((house) => (
            <Link
              className={
                house.id === houseId ? 'text-text font-medium' : 'text-text-muted hover:text-text'
              }
              href={{ pathname: '/damages', query: { house: house.id } }}
              key={house.id}
            >
              {house.name}
            </Link>
          ))}
        </nav>
      )}

      <DamagesManager
        areas={areas
          .filter((area) => area.type === 'living')
          .map((area) => ({ id: area.id, name: area.name }))}
        canReverse={can(context, 'damage.reverse', { houseId })}
        damages={damageViews}
        houseId={houseId}
        roster={rosterView}
      />
    </section>
  );
}
