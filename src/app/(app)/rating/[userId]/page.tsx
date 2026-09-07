import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';

import { listDiscounts } from '@/db/repositories/rating';
import { listCalendarDictionaries } from '@/db/repositories/rotations';
import { can } from '@/lib/authz';
import { NotFoundError, ForbiddenError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { todayInAlmaty } from '@/lib/time';
import { resolveRatingRules } from '@/services/rating';
import { readResidentRating } from '@/services/rating-views';

import { ResidentRatingView } from './resident-rating-view';

export const dynamic = 'force-dynamic';

/** Известные действия админа (§5.2): у остальных кодов названия нет. */
const KNOWN_ACTIONS = ['help', 'violation', 'warning', 'reprimand', 'severe_reprimand'];

export default async function ResidentRatingPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { userId } = await params;
  const { context } = session;
  const actor = { context };

  const view = await readResidentRating(actor, userId).catch((error: unknown) => {
    // Чужая карточка неотличима от несуществующей (P1-1).
    if (error instanceof NotFoundError || error instanceof ForbiddenError) {
      notFound();
    }

    throw error;
  });

  const t = await getTranslations('rating');

  const [rules, dictionaries, discounts] = await Promise.all([
    resolveRatingRules(context, view.houseId === '' ? null : view.houseId),
    view.houseId === ''
      ? Promise.resolve({ members: [] as { userId: string; name: string }[] })
      : listCalendarDictionaries(context, view.houseId),
    listDiscounts(context, { userId }),
  ]);

  const name = dictionaries.members.find((member) => member.userId === userId)?.name ?? '—';

  const actionOptions = Object.entries(rules.actionDeltas)
    .filter(([code]) => KNOWN_ACTIONS.includes(code))
    .map(([code, delta]) => ({ code, delta }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('residentSubtitle')}</p>
      </div>

      <ResidentRatingView
        actionOptions={actionOptions}
        canApproveDiscount={can(context, 'discount.approve', { userId })}
        canCancelFine={can(context, 'fine.cancel', {
          ...(view.houseId === '' ? {} : { houseId: view.houseId }),
          userId,
        })}
        debts={view.debts}
        discounts={discounts.map((discount) => ({
          id: discount.id,
          amount: discount.amount,
          status: discount.status,
        }))}
        events={view.events.map((event) => ({
          id: event.id,
          type: event.type,
          delta: event.delta,
          note: event.note,
          date: todayInAlmaty(event.effectiveAt),
        }))}
        fines={view.fines.map((fine) => ({
          id: fine.id,
          amount: fine.amount,
          reason: fine.reason,
          status: fine.status,
        }))}
        name={name}
        rating={view.rating}
        thresholds={view.thresholds}
        userId={userId}
      />
    </section>
  );
}
