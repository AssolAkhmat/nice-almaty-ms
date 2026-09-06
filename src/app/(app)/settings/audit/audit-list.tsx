'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { parseInstant } from '@/lib/time';

export interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: string | null;
  ip: string | null;
  createdAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Значения показываются как есть: маскирование секретов уже сделано при записи. */
function renderValue(value: unknown): string {
  if (value === null) {
    return '—';
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}

function ValueList({
  values,
  tone,
}: {
  values: Record<string, unknown>;
  tone: 'before' | 'after';
}) {
  const entries = Object.entries(values);

  if (entries.length === 0) {
    return null;
  }

  return (
    <dl className="flex flex-col gap-0.5">
      {entries.map(([name, value]) => (
        <div className="flex flex-wrap items-baseline gap-2" key={name}>
          <dt className="text-label">{name}</dt>
          <dd
            className={
              tone === 'before' ? 'text-text-muted text-[13px] line-through' : 'text-[13px]'
            }
          >
            {renderValue(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function AuditList({ rows }: { rows: readonly AuditRow[] }) {
  const t = useTranslations();
  const format = useFormatter();

  if (rows.length === 0) {
    return <EmptyState description={t('audit.emptyHint')} title={t('audit.empty')} />;
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="audit-list">
      {rows.map((row) => (
        <li key={row.id}>
          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">{row.action}</Badge>
                <span className="text-text-muted text-[13px]">
                  {t(`audit.entities.${row.entityType}`, { fallback: row.entityType })}
                </span>
              </div>
              <span className="tabular text-text-muted text-[13px]">
                {format.dateTime(parseInstant(row.createdAt), {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                })}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap gap-4 text-[13px]">
              <span>
                <span className="text-label">{t('audit.columns.actor')}</span>{' '}
                <span className="tabular">{row.actor ?? '—'}</span>
              </span>
              <span>
                <span className="text-label">{t('audit.columns.ip')}</span>{' '}
                <span className="tabular">{row.ip ?? '—'}</span>
              </span>
            </div>

            {row.before !== null || row.after !== null ? (
              <div className="border-border mt-3 grid gap-3 border-t pt-3 md:grid-cols-2">
                <div>
                  <p className="text-label mb-1">{t('audit.columns.before')}</p>
                  {row.before === null ? (
                    <p className="text-text-muted text-[13px]">—</p>
                  ) : (
                    <ValueList tone="before" values={row.before} />
                  )}
                </div>
                <div>
                  <p className="text-label mb-1">{t('audit.columns.after')}</p>
                  {row.after === null ? (
                    <p className="text-text-muted text-[13px]">—</p>
                  ) : (
                    <ValueList tone="after" values={row.after} />
                  )}
                </div>
              </div>
            ) : null}
          </Card>
        </li>
      ))}
    </ul>
  );
}
