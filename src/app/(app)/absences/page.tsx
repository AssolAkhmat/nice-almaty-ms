import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { AppLink } from '@/components/ui/app-link';
import { EmptyState } from '@/components/ui/empty-state';
import { listHouses } from '@/db/repositories/houses';
import { listResidencies } from '@/db/repositories/residencies';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { addDays, todayInAlmaty } from '@/lib/time';
import { listHouseAbsences, listMyAbsences } from '@/services/absences';

import { AbsencesView, type AbsenceRow } from './absences-view';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Отсутствия (docs/04-MODULES/05-presence.md).
 *
 * Жилец подаёт и видит свои; админ разбирает очередь и смотрит календарь
 * дома. Кто что видит, решает право, а не роль в коде экрана.
 */
export default async function AbsencesPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  if (!can(context, 'absence.read', { houseId: context.houseId, userId: context.userId })) {
    redirect('/');
  }

  const t = await getTranslations('absences');
  const actor: UserActor = { context };

  /*
   * Подача требует не только права, но и проживания: отсутствие подаёт тот,
   * кто в доме живёт. У админа без проживания форма не показывается — ему
   * нечего сообщать о возвращении в дом, где он не живёт.
   */
  const [residency] = await listResidencies(context, { userId: context.userId });
  const canSubmit =
    residency !== undefined &&
    can(context, 'absence.create', { houseId: residency.houseId, userId: context.userId });
  const canReview = can(context, 'absence.review', { houseId: context.houseId });

  const today = todayInAlmaty();
  const tomorrow = addDays(today, 1);

  const mine = canSubmit ? await listMyAbsences(actor) : [];

  /*
   * Дом админа — свой, у жильца — из проживания. Суперадмин выбирает:
   * первый попавшийся дом сети — почти всегда не тот, ради которого он
   * пришёл, а в доме без админа очередь заявок разбирает именно он.
   */
  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const requested = (await searchParams).house;
  const houseId =
    context.role === 'superadmin'
      ? (requested ?? houses[0]?.id ?? null)
      : (context.houseId ?? residency?.houseId ?? null);

  const houseRows =
    canReview && houseId !== null ? await listHouseAbsences(actor, houseId, {}) : [];

  const toRow = (absence: (typeof mine)[number], name?: string): AbsenceRow => ({
    absenceId: absence.id,
    type: absence.type,
    startDate: absence.startDate,
    endDate: absence.endDate,
    reason: absence.reason,
    status: absence.status,
    reviewNote: absence.reviewNote,
    ...(name === undefined ? {} : { name }),
  });

  if (!canSubmit && !canReview) {
    return (
      <section className="flex flex-col gap-6">
        <h1>{t('title')}</h1>
        <EmptyState title={t('nothing')} />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      {houses.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-[13px]">
          {houses.map((house) => (
            <AppLink
              className={
                house.id === houseId ? 'text-text font-medium' : 'text-text-muted hover:text-text'
              }
              data-testid={`house-${house.id}`}
              href={{ pathname: '/absences', query: { house: house.id } }}
              key={house.id}
            >
              {house.name}
            </AppLink>
          ))}
        </nav>
      )}

      <AbsencesView
        canReview={canReview}
        canSubmit={canSubmit}
        houseCalendar={houseRows.map((row) => toRow(row.absence, row.name))}
        mine={mine.map((absence) => toRow(absence))}
        queue={houseRows
          .filter((row) => row.absence.status === 'pending')
          .map((row) => toRow(row.absence, row.name))}
        today={today}
        tomorrow={tomorrow}
      />
    </section>
  );
}
