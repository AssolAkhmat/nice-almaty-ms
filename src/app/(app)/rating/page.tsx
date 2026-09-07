import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { AppLink } from '@/components/ui/app-link';
import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { listHouses } from '@/db/repositories/houses';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { readHouseRating, readMyRatingCard } from '@/services/rating-views';

import { HouseRatingTable } from './house-rating-table';

export const dynamic = 'force-dynamic';

/**
 * Рейтинг (docs/03-BUSINESS-RULES.md §5.6, docs/04-MODULES/08-rating.md).
 *
 * Жильцу — только число. Админу — список жильцов его дома; суперадмину —
 * любого дома сети, и дом он выбирает сам: угадывать за него первый
 * попавшийся значит показывать не тот, который он открыл.
 */
export default async function RatingPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;
  const t = await getTranslations('rating');
  const actor = { context };

  const card = await readMyRatingCard(actor);
  const canReadHouse = can(context, 'rating.history', { houseId: context.houseId });

  const houses = canReadHouse ? await listHouses(context) : [];
  const { house } = await searchParams;

  const houseId = !canReadHouse
    ? null
    : (houses.find((item) => item.id === house)?.id ?? context.houseId ?? houses[0]?.id ?? null);

  const rows = houseId === null ? [] : await readHouseRating(actor, houseId);
  const showPicker = canReadHouse && houses.length > 1;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      {card === null ? null : (
        <Card>
          <CardTitle>{t('mine')}</CardTitle>
          {card.visible && card.rating !== null ? (
            <p className="mt-2 text-[32px] leading-none" data-testid="my-rating">
              {card.rating}
            </p>
          ) : (
            <p className="text-text-muted mt-2 text-[13px]" data-testid="rating-hidden">
              {t('hidden')}
            </p>
          )}
        </Card>
      )}

      {showPicker ? (
        <nav className="flex flex-wrap gap-2" data-testid="rating-houses">
          {houses.map((item) => (
            <AppLink
              className={
                houseId === item.id
                  ? 'border-border bg-surface-2 rounded-lg border px-3 py-1.5 text-[13px]'
                  : 'border-border rounded-lg border px-3 py-1.5 text-[13px]'
              }
              href={{ pathname: '/rating', query: { house: item.id } }}
              key={item.id}
            >
              {item.name}
            </AppLink>
          ))}
        </nav>
      ) : null}

      {!canReadHouse ? null : rows.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <HouseRatingTable rows={rows} />
      )}
    </section>
  );
}
