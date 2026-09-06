'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { PASSWORD_MIN_LENGTH } from '@/lib/validation/password';

import { changePasswordAction, type AuthFormState } from '../actions';

const INITIAL: AuthFormState = {};

export function ChangePasswordForm({ required }: { required: boolean }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(changePasswordAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4" data-testid="change-password-form">
      <h1>{t('auth.changePassword.title')}</h1>
      <p className="text-text-muted text-[13px]">
        {required ? t('auth.changePassword.required') : t('auth.changePassword.hint')}
      </p>

      <Field
        hint={t('auth.changePassword.rule', { min: PASSWORD_MIN_LENGTH })}
        htmlFor="password"
        label={t('auth.fields.newPassword')}
      >
        <Input
          autoComplete="new-password"
          data-testid="new-password"
          id="password"
          minLength={PASSWORD_MIN_LENGTH}
          name="password"
          required
          type="password"
        />
      </Field>

      <Field htmlFor="confirmation" label={t('auth.fields.confirmation')}>
        <Input
          autoComplete="new-password"
          data-testid="confirmation"
          id="confirmation"
          minLength={PASSWORD_MIN_LENGTH}
          name="confirmation"
          required
          type="password"
        />
      </Field>

      {state.error !== undefined ? (
        <p className="text-danger text-[13px]" data-testid="change-password-error" role="alert">
          {t(state.error)}
        </p>
      ) : null}

      <Button data-testid="submit" disabled={isPending} type="submit">
        {isPending ? t('common.loading') : t('auth.changePassword.submit')}
      </Button>
    </form>
  );
}
