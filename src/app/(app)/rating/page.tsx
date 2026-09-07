import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { listResidencies } from '@/db/repositories/residencies';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { readHouseRating, readMyRatingCard } from '@/services/rating-views';

import { HouseRatingTable } from './house-rating-table';

export const dynamic = 'force-dynamic';

/**
 * Рейтинг (docs/03-BUSINESS-RULES.md §5.6, docs/04-MODULES/08-rating.md).
 *
 * Жильцу — только число. Админу — список жильцов дома с долгами и штрафами;
 * история открывается по человеку. Что кому видно, решает право.
 */
export default async function RatingPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;
  const t = await getTranslations('rating');
  const actor = { context };

  const card = await readMyRatingCard(actor);
  const canReadHouse = can(context, 'rating.history', { houseId: context.houseId });

  const houseId = canReadHouse
    ? (context.houseId ?? (await listResidencies(context, {}))[0]?.houseId ?? null)
    : null;

  const rows = houseId === null ? [] : await readHouseRating(actor, houseId);

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

      {!canReadHouse ? null : rows.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <HouseRatingTable rows={rows} />
      )}
    </section>
  );
}
