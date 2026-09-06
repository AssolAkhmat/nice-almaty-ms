import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { parseBusinessDate, startOfDayUtc } from '@/lib/time';

import type { Invoice } from '@/db/schema';

export interface TerminationNoticeProps {
  moveOutDate: string | null;
  balance: number;
  deadline: string | null;
  daysLeft: number | null;
  refundStatus: Invoice['status'] | null;
}

/**
 * Сводка выселения на дэшборде жильца (§2.3).
 *
 * Мастер заселения здесь уже неуместен: заселение позади. Жилец видит дату
 * выезда, остаток депозита и срок возврата — то есть ровно то, что ему ещё
 * предстоит получить, и когда.
 */
export async function TerminationNotice({
  balance,
  daysLeft,
  deadline,
  moveOutDate,
  refundStatus,
}: TerminationNoticeProps) {
  const t = await getTranslations('terminations');
  const format = await getFormatter();

  const date = (value: string) =>
    format.dateTime(startOfDayUtc(parseBusinessDate(value)), {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

  return (
    <Card data-testid="termination-notice">
      <CardHeader>
        <CardTitle>{t('noticeTitle')}</CardTitle>
        <Badge tone="warning">{t('statusTerminating')}</Badge>
      </CardHeader>

      <div className="flex flex-col gap-2 p-4 pt-0 text-[13px]">
        <p className="text-text-muted">{t('noticeHint')}</p>

        {moveOutDate !== null && (
          <div className="flex justify-between gap-4">
            <span>{t('moveOutDate')}</span>
            <span>{date(moveOutDate)}</span>
          </div>
        )}

        <div className="flex justify-between gap-4">
          <span>{t('balance')}</span>
          <Money amount={balance} />
        </div>

        {deadline !== null && (
          <div className="flex justify-between gap-4">
            <span>{t('deadline')}</span>
            <span>{date(deadline)}</span>
          </div>
        )}

        {daysLeft !== null && (
          <div className="flex justify-between gap-4">
            <span>{t('daysLeft')}</span>
            <span>
              {daysLeft < 0 ? t('overdue', { days: -daysLeft }) : t('days', { days: daysLeft })}
            </span>
          </div>
        )}

        {refundStatus !== null && (
          <div className="flex justify-between gap-4">
            <span>{t('refundInvoice')}</span>
            <Badge tone={refundStatus === 'returned' ? 'success' : 'info'}>
              {t(`refundStatus.${refundStatus}`)}
            </Badge>
          </div>
        )}

        <div className="flex flex-wrap gap-3 pt-2">
          <Link className="text-accent underline" href="/profile">
            {t('links.profile')}
          </Link>
          <Link className="text-accent underline" href="/deposit">
            {t('links.deposit')}
          </Link>
        </div>
      </div>
    </Card>
  );
}
