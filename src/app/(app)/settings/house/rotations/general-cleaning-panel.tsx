'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

import {
  planGeneralCleaningAction,
  setCancelRegularAction,
  type RotationSetupActionState,
} from './actions';

const INITIAL: RotationSetupActionState = {};

/**
 * Генеральная уборка (§6.5): последнее воскресенье месяца, дата правится
 * вручную, расклад детерминирован по дому и дате.
 */
export function GeneralCleaningPanel({
  cancelRegular,
  defaultDate,
  houseId,
}: {
  cancelRegular: boolean;
  defaultDate: string;
  houseId: string;
}) {
  const t = useTranslations('generalCleaning');
  const tAll = useTranslations();
  const [planState, plan, isPlanning] = useActionState(planGeneralCleaningAction, INITIAL);
  const [settingState, saveSetting, isSaving] = useActionState(setCancelRegularAction, INITIAL);
  const router = useRouter();

  useEffect(() => {
    if (planState.done !== undefined || settingState.done !== undefined) {
      router.refresh();
    }
  }, [planState, router, settingState]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-4">
        <form action={plan} className="flex flex-wrap items-end gap-2" data-testid="general-form">
          <input name="houseId" type="hidden" value={houseId} />

          <div className="w-48">
            <Field hint={t('dateHint')} htmlFor="general-date" label={t('date')}>
              <Input
                data-testid="general-date"
                defaultValue={defaultDate}
                id="general-date"
                name="date"
                required
                type="date"
              />
            </Field>
          </div>

          <Button data-testid="general-plan" disabled={isPlanning} size="sm" type="submit">
            {t('plan')}
          </Button>
        </form>

        {planState.error !== undefined && (
          <p className="text-danger text-[13px]" role="alert">
            {tAll(planState.error)}
          </p>
        )}
        {planState.done !== undefined && (
          <p className="text-success text-[13px]" data-testid="general-done">
            {tAll(planState.done)}
          </p>
        )}

        <form
          action={saveSetting}
          className="border-border flex flex-wrap items-center gap-3 border-t pt-4"
          data-testid="general-setting-form"
        >
          <input name="houseId" type="hidden" value={houseId} />

          <label className="flex items-center gap-2 text-[13px]">
            <input
              className="accent-primary size-4"
              data-testid="general-cancel-regular"
              defaultChecked={cancelRegular}
              name="cancelRegular"
              type="checkbox"
            />
            {t('cancelRegular')}
          </label>

          <Button
            data-testid="general-setting-save"
            disabled={isSaving}
            size="sm"
            type="submit"
            variant="ghost"
          >
            {t('save')}
          </Button>
        </form>

        {settingState.done !== undefined && (
          <p className="text-success text-[13px]">{tAll(settingState.done)}</p>
        )}
      </div>
    </Card>
  );
}
