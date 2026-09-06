import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listAuditEntries } from '@/db/repositories/audit-log';
import { listUsers } from '@/db/repositories/users';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { startOfDayUtc, startOfNextDayUtc, tryParseBusinessDate } from '@/lib/time';

import { AuditFilters } from './audit-filters';
import { AuditList, type AuditRow } from './audit-list';

export const dynamic = 'force-dynamic';

const ENTITY_TYPES = ['user', 'house', 'setting'] as const;

function single(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Журнал действий. Читает только суперадмин (docs/03-BUSINESS-RULES.md §11);
 * проверку делает репозиторий, экран лишь не рисует недоступное.
 *
 * Экспорт CSV отложен до фазы 6 вместе с остальными выгрузками.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  if (!can(session.context, 'audit.read')) {
    // Раздел вне области видимости роли неотличим от несуществующего (P1-1).
    redirect('/settings');
  }

  const t = await getTranslations('audit');
  const params = await searchParams;

  const actorUserId = single(params.actor);
  const entityType = single(params.entity);
  const from = tryParseBusinessDate(single(params.from));
  const to = tryParseBusinessDate(single(params.to));

  const [entries, actors] = await Promise.all([
    listAuditEntries(
      session.context,
      {
        ...(actorUserId === '' ? {} : { actorUserId }),
        ...(entityType === '' ? {} : { entityType }),
        // Границы периода считаются по календарю Алматы, а не по UTC.
        ...(from === null ? {} : { from: startOfDayUtc(from) }),
        ...(to === null ? {} : { to: startOfNextDayUtc(to) }),
        limit: 200,
      },
      undefined,
    ),
    listUsers(session.context),
  ]);

  const actorNames = new Map(actors.map((actor) => [actor.id, actor.phone]));

  const rows: AuditRow[] = entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    actor: entry.actorUserId === null ? null : (actorNames.get(entry.actorUserId) ?? null),
    ip: entry.ip,
    createdAt: entry.createdAt.toISOString(),
    before: entry.before as Record<string, unknown> | null,
    after: entry.after as Record<string, unknown> | null,
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <AuditFilters
        actors={actors.map((actor) => ({ id: actor.id, phone: actor.phone }))}
        entityTypes={[...ENTITY_TYPES]}
        selected={{ actor: actorUserId, entity: entityType, from: from ?? '', to: to ?? '' }}
      />

      <AuditList rows={rows} />
    </section>
  );
}
