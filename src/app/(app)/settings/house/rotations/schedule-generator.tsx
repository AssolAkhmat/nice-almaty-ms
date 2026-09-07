'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

import { generateScheduleAction, type RotationSetupActionState } from './actions';

const INITIAL: RotationSetupActionState = {};

/**
 * «Сгенерировать расписание до <дата>» (§6.6).
 *
 * Занятия материализуются в базу, а не считаются на лету: их переносят,
 * отменяют и переназначают, и всё это должно где-то жить.
 */
export function ScheduleGenerator({
  defaultUntil,
  houseId,
  scheduledCount,
}: {
  defaultUntil: string;
  houseId: string;
  scheduledCount: number;
}) {
  const t = useTranslations('rotationSchedule');
  // Ошибки приходят ключами из своих разделов: перевод берётся целиком.
  const tAll = useTranslations();
  const [state, submit, isPending] = useActionState(generateScheduleAction, INITIAL);
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-3">
        <p className="text-text-muted text-[13px]" data-testid="schedule-count">
          {t('scheduled', { count: scheduledCount })}
        </p>

        <form action={submit} className="flex flex-wrap items-end gap-2">
          <input name="houseId" type="hidden" value={houseId} />

          <div className="w-48">
            <Field hint={t('untilHint')} htmlFor="schedule-until" label={t('until')}>
              <Input
                data-testid="schedule-until"
                defaultValue={defaultUntil}
                id="schedule-until"
                name="until"
                required
                type="date"
              />
            </Field>
          </div>

          <Button data-testid="schedule-generate" disabled={isPending} size="sm" type="submit">
            {t('generate')}
          </Button>
        </form>

        {state.error !== undefined && (
          <p className="text-danger text-[13px]" role="alert">
            {tAll(state.error)}
          </p>
        )}
        {state.done !== undefined && (
          <p className="text-success text-[13px]" data-testid="schedule-done">
            {tAll(state.done)}
          </p>
        )}
      </div>
    </Card>
  );
}
