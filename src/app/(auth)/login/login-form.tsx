'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

import { loginAction, type AuthFormState } from '../actions';

const INITIAL: AuthFormState = {};

export function LoginForm({ passwordChanged }: { passwordChanged: boolean }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(loginAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4" data-testid="login-form">
      <h1>{t('auth.signIn.title')}</h1>
      <p className="text-text-muted text-[13px]">{t('auth.signIn.hint')}</p>

      {passwordChanged ? (
        <p className="text-success text-[13px]" data-testid="password-changed">
          {t('auth.changePassword.done')}
        </p>
      ) : null}

      <Field htmlFor="phone" label={t('auth.fields.phone')}>
        <Input
          autoComplete="tel"
          data-testid="phone"
          id="phone"
          inputMode="tel"
          name="phone"
          placeholder="+7 700 000 00 00"
          required
        />
      </Field>

      <Field htmlFor="password" label={t('auth.fields.password')}>
        <Input
          autoComplete="current-password"
          data-testid="password"
          id="password"
          name="password"
          required
          type="password"
        />
      </Field>

      {state.error !== undefined ? (
        <p className="text-danger text-[13px]" data-testid="login-error" role="alert">
          {state.retryAfterSeconds !== undefined && state.retryAfterSeconds > 0
            ? t('auth.errors.rate_limited_with_seconds', { seconds: state.retryAfterSeconds })
            : t(state.error)}
        </p>
      ) : null}

      <Button data-testid="submit" disabled={isPending} type="submit">
        {isPending ? t('common.loading') : t('auth.signIn.submit')}
      </Button>
    </form>
  );
}
