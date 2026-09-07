import { AppLink } from '@/components/ui/app-link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { listResidencies } from '@/db/repositories/residencies';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { addMonths, startOfMonth, todayInAlmaty, tryParseBusinessDate } from '@/lib/time';
import { readRotationStats } from '@/services/rotation-stats';

import { StatsView } from './stats-view';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Статистика ротаций (docs/04-MODULES/04-rotation-scoring.md).
 *
 * Оценки видит только админ и суперадмин (§7), поэтому и раздел закрыт
 * правом на оценку. Период по умолчанию — три месяца назад: за меньший
 * средняя оценка ещё ни о чём не говорит. Экспорт CSV/XLSX — фаза 6.
 */
export default async function RotationStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  if (!can(context, 'rotation.score', { houseId: context.houseId })) {
    redirect('/rotations');
  }

  const t = await getTranslations('rotationStats');
  const actor: UserActor = { context };
  const params = await searchParams;

  const today = todayInAlmaty();
  const from = tryParseBusinessDate(params.from ?? '') ?? startOfMonth(addMonths(today, -2));
  const to = tryParseBusinessDate(params.to ?? '') ?? today;

  const houseId =
    context.role === 'superadmin'
      ? (params.house ?? (await listResidencies(context, {}))[0]?.houseId ?? null)
      : context.houseId;

  if (houseId === null) {
    return (
      <section className="flex flex-col gap-6">
        <h1>{t('title')}</h1>
        <EmptyState description={t('noHouseHint')} title={t('noHouse')} />
      </section>
    );
  }

  const stats = await readRotationStats(actor, houseId, { from, to });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted flex items-center gap-2 text-[13px]">
          <span>
            {from} — {to}
          </span>
          <Badge tone="neutral">{t('total', { count: stats.total })}</Badge>
        </p>
        <AppLink className="text-accent text-[13px] underline" href="/rotations">
          {t('toCalendar')}
        </AppLink>
      </div>

      <StatsView
        areas={stats.byArea.map((area) => ({
          areaId: area.areaId,
          name: area.name,
          averageScore: area.averageScore,
          missRate: area.missRate,
        }))}
        months={stats.months.map((month) => ({
          month: month.month,
          done: month.done,
          missed: month.missed,
          averageScore: month.averageScore,
        }))}
        people={stats.byPerson.map((person) => ({
          userId: person.userId,
          name: person.name,
          done: person.done,
          missed: person.missed,
          averageScore: person.averageScore,
        }))}
        weekdays={stats.byWeekday.map((day) => ({
          weekday: day.weekday,
          done: day.done,
          missed: day.missed,
          averageScore: day.averageScore,
        }))}
      />
    </section>
  );
}
