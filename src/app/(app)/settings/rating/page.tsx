import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { AppLink } from '@/components/ui/app-link';
import { listHouses } from '@/db/repositories/houses';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { readRatingRuleTable } from '@/services/rating-rules';

import { RatingRulesForm, type RuleField } from './rating-rules-form';

export const dynamic = 'force-dynamic';

/** Известные действия админа из §5.2: у них есть человеческие названия. */
const KNOWN_ACTIONS = ['help', 'violation', 'warning', 'reprimand', 'severe_reprimand'];

export default async function RatingRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  if (!can(session.context, 'rating.rules')) {
    // Раздел вне области видимости роли неотличим от несуществующего (P1-1).
    redirect('/settings');
  }

  const { house } = await searchParams;
  const houses = await listHouses(session.context);
  const houseId = houses.some((item) => item.id === house) ? (house ?? null) : null;

  const t = await getTranslations('rating.rules');
  const actor = { context: session.context };
  const table = await readRatingRuleTable(actor, houseId);

  const overridden = new Set(
    table.rows.filter((row) => row.level === 'house').map((row) => row.code),
  );

  const field = (code: string, label: string, value: number, actions?: string): RuleField => ({
    code,
    label,
    value,
    overridden: overridden.has(code),
    ...(actions === undefined ? {} : { actions }),
  });

  const scores = Object.keys(table.rules.scoreDeltas)
    .map(Number)
    .sort((a, b) => b - a)
    .map((score) =>
      field(`score:${String(score)}`, t('score', { score }), table.rules.scoreDeltas[score] ?? 0),
    );

  const actions = Object.keys(table.rules.actionDeltas).map((code) =>
    field(
      code,
      KNOWN_ACTIONS.includes(code) ? t(`action.${code}`) : code,
      table.rules.actionDeltas[code] ?? 0,
    ),
  );

  const down = table.rules.downThresholds.map((rule) =>
    field(
      `down:${String(rule.threshold)}`,
      t('downThreshold', { threshold: rule.threshold }),
      rule.fineAmount,
      rule.actions.join(','),
    ),
  );

  const up = table.rules.upThresholds.map((rule) =>
    field(
      `up:${String(rule.threshold)}`,
      t('upThreshold', { threshold: rule.threshold }),
      rule.discountAmount,
    ),
  );

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <nav className="flex flex-wrap gap-2" data-testid="rules-level">
        <AppLink
          className={
            houseId === null
              ? 'border-border bg-surface-2 rounded-lg border px-3 py-1.5 text-[13px]'
              : 'border-border rounded-lg border px-3 py-1.5 text-[13px]'
          }
          href="/settings/rating"
        >
          {t('network')}
        </AppLink>
        {houses.map((item) => (
          <AppLink
            className={
              houseId === item.id
                ? 'border-border bg-surface-2 rounded-lg border px-3 py-1.5 text-[13px]'
                : 'border-border rounded-lg border px-3 py-1.5 text-[13px]'
            }
            href={{ pathname: '/settings/rating', query: { house: item.id } }}
            key={item.id}
          >
            {item.name}
          </AppLink>
        ))}
      </nav>

      <RatingRulesForm
        actions={actions}
        down={down}
        houseId={houseId}
        houses={houses.map((item) => ({ id: item.id, name: item.name }))}
        scores={scores}
        up={up}
      />
    </section>
  );
}
