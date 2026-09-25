'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Textarea } from '@/components/ui/input';

import { saveWelcomeMessageAction, type NetworkActionState } from './actions';

const INITIAL: NetworkActionState = {};

/**
 * Приветственное сообщение новому жильцу (указание владельца,
 * 25 сентября 2026).
 *
 * Уходит в WhatsApp вместе с временным паролем — тем же сообщением, которое
 * видно здесь. Доступны три подстановки: адрес, логин и пароль. Больше
 * в сообщение не попадает ничего: ни ИИН, ни названия дома, ни ФИО —
 * переписка в мессенджере остаётся у обоих навсегда.
 *
 * Пустое поле возвращает текст по умолчанию из словаря: так «вернуть как
 * было» не требует помнить исходный текст наизусть.
 */
export function WelcomeForm({ message, fallback }: { message: string | null; fallback: string }) {
  const t = useTranslations('users.welcome');
  const [state, action, isPending] = useActionState(saveWelcomeMessageAction, INITIAL);
  const [value, setValue] = useState(message ?? fallback);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <form action={action} className="flex max-w-xl flex-col gap-3 p-4 pt-0">
        <Field hint={t('hint')} htmlFor="welcome-message" label={t('title')}>
          <Textarea
            data-testid="welcome-message"
            id="welcome-message"
            name="message"
            onChange={(event) => {
              setValue(event.target.value);
            }}
            rows={5}
            value={value}
          />
        </Field>

        {state.error !== undefined && (
          <p className="text-danger text-[13px]" role="alert">
            {state.error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button disabled={isPending} size="sm" type="submit">
            {t('save')}
          </Button>

          <Button
            onClick={() => {
              setValue(fallback);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t('reset')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
