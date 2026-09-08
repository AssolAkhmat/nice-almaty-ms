'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

import { changeOwnPhoneAction, type PersonalActionState } from './actions';

const INITIAL: PersonalActionState = {};

/**
 * Смена собственного номера (T9.7). Номер — логин, поэтому рядом с новым
 * номером спрашивается действующий пароль: без него чужая открытая сессия
 * могла бы увести учётную запись на другой телефон.
 */
export function PhoneForm({ phone }: { phone: string }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(changeOwnPhoneAction, INITIAL);
  /*
   * Номер держится в состоянии: после ответа действия React сбрасывает
   * неконтролируемые поля к исходным, и при неверном пароле введённый номер
   * пропадал бы — повторная отправка молча уходила бы со старым.
   */
  const [value, setValue] = useState(phone);

  return (
    <form action={action} className="flex max-w-sm flex-col gap-4" data-testid="phone-form">
      <Field
        hint={t('settings.phone.hint')}
        htmlFor="new-phone"
        label={t('settings.phone.newPhone')}
      >
        <Input
          autoComplete="tel"
          data-testid="new-own-phone"
          id="new-phone"
          inputMode="tel"
          name="phone"
          onChange={(event) => {
            setValue(event.target.value);
          }}
          required
          type="tel"
          value={value}
        />
      </Field>

      <Field htmlFor="current-password" label={t('settings.phone.currentPassword')}>
        <Input
          autoComplete="current-password"
          data-testid="current-password"
          id="current-password"
          name="currentPassword"
          required
          type="password"
        />
      </Field>

      {state.done !== undefined ? (
        <p className="text-success text-[13px]" data-testid="phone-changed" role="status">
          {t(state.done)}
        </p>
      ) : null}
      {state.error !== undefined ? (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      ) : null}

      <Button data-testid="phone-submit" disabled={isPending} type="submit" variant="secondary">
        {isPending ? t('common.loading') : t('settings.phone.submit')}
      </Button>
    </form>
  );
}
