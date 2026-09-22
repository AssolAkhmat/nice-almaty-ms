'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

import { openPeriodAction, type UtilityActionState } from './actions';

const INITIAL: UtilityActionState = {};

/**
 * Заведение периода за выбранный месяц.
 *
 * Раньше период создавался сам при показе экрана, а выбрать можно было
 * только три прошлых месяца: текущего в списке не было вовсе, и сентябрь
 * завести было нельзя (указание владельца, 22 сентября 2026). Теперь показ
 * месяца ничего не создаёт, а создание — отдельное действие с кнопкой.
 */
export function StartPeriod({ houseId, month }: { houseId: string; month: string }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(openPeriodAction, INITIAL);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('utilities.notStarted')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0">
        <p className="text-text-muted text-[13px]">{t('utilities.notStartedHint')}</p>

        {state.error !== undefined && (
          <p className="text-danger text-[13px]" role="alert">
            {t(state.error)}
          </p>
        )}

        <form action={action}>
          <input name="houseId" type="hidden" value={houseId} />
          <input name="month" type="hidden" value={month} />

          <Button data-testid="start-period" disabled={isPending} size="sm" type="submit">
            {t('utilities.startPeriod', { month: month.slice(0, 7) })}
          </Button>
        </form>
      </div>
    </Card>
  );
}
