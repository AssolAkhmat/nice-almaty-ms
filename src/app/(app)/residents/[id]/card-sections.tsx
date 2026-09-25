import { getFormatter, getTranslations } from 'next-intl/server';

import { FileLinks } from '@/components/files/file-links';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { parseInstant } from '@/lib/time';

import type { AuditLogEntry } from '@/db/schema';
import type { DepositView } from '@/services/deposits';
import type { InvoiceRow } from '@/services/invoices';
import type { ResidentRatingView } from '@/services/rating-views';

/**
 * Разделы карточки жильца (модуль 1, «Карточка жильца»; указание владельца
 * от 25 сентября 2026).
 *
 * Карточка закрывала три пункта из девяти, а остальное было ссылками
 * на общие экраны: «перейти к документам этого жильца» из неё было нельзя
 * в принципе. Разделы читают те же сервисы, что и свои экраны, — копий
 * расчётов здесь нет.
 *
 * Серверные компоненты: всё только показывается. Действия остались там,
 * где живут: проверка документов — в очереди, оценки — в рейтинге.
 */
function shortDate(value: string): string {
  return value.slice(0, 10).split('-').reverse().join('.');
}

export async function DepositSection({ view }: { view: DepositView }) {
  const t = await getTranslations();
  const format = await getFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('deposit.title')}</CardTitle>
        <Money amount={view.balance} />
      </CardHeader>

      <div className="flex flex-col gap-2 p-4 pt-0 text-[13px]">
        {view.transactions.length === 0 ? (
          <p className="text-text-muted">{t('deposit.noMovements')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {view.transactions.map((transaction) => (
              <li
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                key={transaction.id}
              >
                <span>
                  {transaction.note ?? t(`deposit.movement.${transaction.type}`)}
                  <span className="text-text-muted ml-2">
                    {format.dateTime(transaction.createdAt, {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    })}
                  </span>
                </span>

                <span className="flex items-center gap-3">
                  {view.receiptOf[transaction.id] !== undefined && (
                    <FileLinks
                      fileId={view.receiptOf[transaction.id] ?? ''}
                      label={t('files.receipt')}
                    />
                  )}
                  <Money amount={transaction.amount} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export async function InvoicesSection({
  rows,
}: {
  rows: readonly (InvoiceRow & { href: string })[];
}) {
  const t = await getTranslations();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('invoices.title')}</CardTitle>
      </CardHeader>

      <div className="p-4 pt-0 text-[13px]">
        {rows.length === 0 ? (
          <p className="text-text-muted">{t('invoices.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((row) => (
              <li
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                key={row.invoice.id}
              >
                <span>
                  {t(`invoices.type.${row.invoice.type}`)}
                  {row.invoice.periodMonth !== null && (
                    <span className="text-text-muted ml-2">
                      {row.invoice.periodMonth.slice(0, 7)}
                    </span>
                  )}
                  {row.overdue && (
                    <Badge className="ml-2" tone="danger">
                      {t('invoices.overdue')}
                    </Badge>
                  )}
                </span>

                <span className="flex items-center gap-3">
                  <span className="text-text-muted">
                    {t(`invoices.status.${row.invoice.status}`)}
                  </span>
                  <Money amount={row.remaining} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export interface RotationSummaryView {
  done: number;
  missed: number;
  averageScore: number | null;
  debts: number;
}

export async function RotationsSection({ summary }: { summary: RotationSummaryView }) {
  const t = await getTranslations();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('rotations.title')}</CardTitle>
      </CardHeader>

      <div className="grid gap-2 p-4 pt-0 text-[13px] md:grid-cols-4">
        <span>
          {t('rotationStats.done')}: <b>{summary.done}</b>
        </span>
        <span>
          {t('rotationStats.missed')}: <b>{summary.missed}</b>
        </span>
        <span>
          {t('rotationStats.average')}:{' '}
          <b>{summary.averageScore === null ? '—' : summary.averageScore.toFixed(1)}</b>
        </span>
        <span>{t('rating.debtsCount', { count: summary.debts })}</span>
      </div>
    </Card>
  );
}

export async function RatingSection({ view }: { view: ResidentRatingView }) {
  const t = await getTranslations();

  /* Штрафы приходят всеми статусами: в сумму идут только непогашенные. */
  const pending = view.fines.filter((fine) => fine.status === 'pending');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('rating.title')}</CardTitle>
        <span className="text-[20px] font-medium">{view.rating}</span>
      </CardHeader>

      <div className="flex flex-col gap-2 p-4 pt-0 text-[13px]">
        <span className="text-text-muted flex flex-wrap items-center gap-2">
          {t('rating.debtsCount', { count: view.debts })}
          {pending.length > 0 && (
            <span className="flex items-center gap-1">
              {t('rating.fines')}
              <Money amount={pending.reduce((sum, fine) => sum + fine.amount, 0)} />
            </span>
          )}
        </span>

        {view.events.length === 0 ? (
          <p className="text-text-muted">{t('rating.noEvents')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {view.events.slice(-8).map((event) => (
              <li
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                key={event.id}
              >
                <span>
                  {event.note ?? event.type}
                  <span className="text-text-muted ml-2">
                    {shortDate(event.effectiveAt.toISOString())}
                  </span>
                </span>
                <span className={event.delta < 0 ? 'text-danger' : ''}>
                  {event.delta > 0 ? `+${String(event.delta)}` : event.delta}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export async function HistorySection({ entries }: { entries: readonly AuditLogEntry[] }) {
  const t = await getTranslations();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('residents.historyTitle')}</CardTitle>
      </CardHeader>

      <div className="p-4 pt-0 text-[13px]">
        {entries.length === 0 ? (
          <EmptyState
            description={t('residents.historyEmptyHint')}
            title={t('residents.historyEmpty')}
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {entries.map((entry) => (
              <li
                className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1"
                key={entry.id}
              >
                <span>
                  {entry.action}
                  <span className="text-text-muted ml-2">
                    {t(`audit.entities.${entry.entityType}`)}
                  </span>
                </span>
                <span className="text-text-muted shrink-0">
                  {shortDate(parseInstant(entry.createdAt.toISOString()).toISOString())}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
