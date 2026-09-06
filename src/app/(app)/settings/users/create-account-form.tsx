'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';

import { createAccountAction, type AccountActionState } from './actions';

const INITIAL: AccountActionState = {};

export interface HouseOption {
  id: string;
  name: string;
}

export function CreateAccountForm({ houses }: { houses: readonly HouseOption[] }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(createAccountAction, INITIAL);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('users.create.title')}</CardTitle>
      </CardHeader>

      <form action={action} className="flex flex-col gap-3" data-testid="create-account-form">
        <Field htmlFor="phone" label={t('users.columns.phone')}>
          <Input
            data-testid="new-phone"
            id="phone"
            inputMode="tel"
            name="phone"
            placeholder="+7 700 000 00 00"
            required
          />
        </Field>

        <Field htmlFor="role" label={t('users.columns.role')}>
          <Select data-testid="new-role" defaultValue="resident" id="role" name="role">
            <option value="resident">{t('users.roles.resident')}</option>
            <option value="admin">{t('users.roles.admin')}</option>
            <option value="superadmin">{t('users.roles.superadmin')}</option>
          </Select>
        </Field>

        <Field
          hint={t('users.create.houseHint')}
          htmlFor="houseId"
          label={t('users.columns.house')}
        >
          <Select data-testid="new-house" defaultValue="" id="houseId" name="houseId">
            <option value="">{t('users.create.noHouse')}</option>
            {houses.map((house) => (
              <option key={house.id} value={house.id}>
                {house.name}
              </option>
            ))}
          </Select>
        </Field>

        {state.error !== undefined ? (
          <p className="text-danger text-[13px]" data-testid="create-error" role="alert">
            {t(state.error)}
          </p>
        ) : null}

        {state.temporaryPassword !== undefined ? (
          <div
            className="rounded-control border-border bg-surface-2 border p-3"
            data-testid="temporary-password"
            role="status"
          >
            <p className="text-text-muted text-[13px]">{t('users.create.passwordOnce')}</p>
            <p
              className="tabular mt-1 text-[15px] font-semibold"
              data-testid="temporary-password-value"
            >
              {state.temporaryPassword}
            </p>
            <p className="text-text-muted mt-1 text-[13px]">{state.createdPhone}</p>
          </div>
        ) : null}

        <Button data-testid="create-submit" disabled={isPending} type="submit">
          {isPending ? t('common.loading') : t('users.create.submit')}
        </Button>
      </form>
    </Card>
  );
}
