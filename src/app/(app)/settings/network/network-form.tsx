'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/checkbox';
import { LOCALES } from '@/lib/i18n/config';
import { useState } from 'react';

import { saveNetworkSettingsAction, type NetworkActionState } from './actions';

const INITIAL: NetworkActionState = {};

export function NetworkForm({
  ratingVisibleToResidents,
  defaultLocale,
}: {
  ratingVisibleToResidents: boolean;
  defaultLocale: string;
}) {
  const t = useTranslations();
  const [visible, setVisible] = useState(ratingVisibleToResidents);
  const [state, action, isPending] = useActionState(saveNetworkSettingsAction, INITIAL);

  return (
    <form action={action} className="flex max-w-sm flex-col gap-4" data-testid="network-settings">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[15px]">{t('settings.network.ratingVisible')}</span>
          <span className="text-text-muted text-[13px]">
            {t('settings.network.ratingVisibleHint')}
          </span>
        </div>
        <Switch
          checked={visible}
          data-testid="rating-visible"
          name="ratingVisibleToResidents"
          onCheckedChange={setVisible}
        />
      </div>

      <Field
        hint={t('settings.network.defaultLocaleHint')}
        htmlFor="defaultLocale"
        label={t('settings.network.defaultLocale')}
      >
        <Select
          data-testid="default-locale"
          defaultValue={defaultLocale}
          id="defaultLocale"
          name="defaultLocale"
        >
          {LOCALES.map((value) => (
            <option key={value} value={value}>
              {t(`language.${value}`)}
            </option>
          ))}
        </Select>
      </Field>

      {state.done !== undefined ? (
        <p className="text-success text-[13px]" data-testid="network-saved" role="status">
          {t(state.done)}
        </p>
      ) : null}
      {state.error !== undefined ? (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      ) : null}

      <Button data-testid="network-submit" disabled={isPending} type="submit">
        {isPending ? t('common.loading') : t('settings.network.submit')}
      </Button>
    </form>
  );
}
