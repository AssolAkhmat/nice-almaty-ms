'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/input';
import { useTheme } from '@/components/theme/theme-provider';
import { LOCALES } from '@/lib/i18n/config';
import { isTheme, THEMES } from '@/lib/theme';

import { savePersonalSettingsAction, type PersonalActionState } from './actions';

const INITIAL: PersonalActionState = {};

export function PersonalForm({ locale, theme }: { locale: string; theme: string }) {
  const t = useTranslations();
  const { setTheme } = useTheme();
  const [state, action, isPending] = useActionState(savePersonalSettingsAction, INITIAL);

  return (
    <form
      action={(formData) => {
        /*
         * Тема применяется в браузере сразу и сохраняется в профиль.
         * Хранилище браузера остаётся быстрым путём: скрипт до отрисовки
         * читает именно его, до профиля он дотянуться не успевает.
         */
        const next = formData.get('theme');
        if (isTheme(next)) {
          setTheme(next);
        }

        action(formData);
      }}
      className="flex max-w-sm flex-col gap-4"
      data-testid="personal-settings"
    >
      <Field hint={t('settings.personal.localeHint')} htmlFor="locale" label={t('language.label')}>
        <Select data-testid="personal-locale" defaultValue={locale} id="locale" name="locale">
          {LOCALES.map((value) => (
            <option key={value} value={value}>
              {t(`language.${value}`)}
            </option>
          ))}
        </Select>
      </Field>

      <Field hint={t('settings.personal.themeHint')} htmlFor="theme" label={t('theme.label')}>
        <Select data-testid="personal-theme" defaultValue={theme} id="theme" name="theme">
          {THEMES.map((value) => (
            <option key={value} value={value}>
              {t(`theme.${value}`)}
            </option>
          ))}
        </Select>
      </Field>

      {state.done !== undefined ? (
        <p className="text-success text-[13px]" data-testid="personal-saved" role="status">
          {t(state.done)}
        </p>
      ) : null}
      {state.error !== undefined ? (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      ) : null}

      <Button data-testid="personal-submit" disabled={isPending} type="submit">
        {isPending ? t('common.loading') : t('settings.personal.submit')}
      </Button>
    </form>
  );
}
