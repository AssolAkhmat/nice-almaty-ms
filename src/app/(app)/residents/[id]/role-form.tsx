'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/input';

import { changeRoleAction, type RoleActionState } from './actions';

const INITIAL: RoleActionState = {};

export interface HouseOption {
  id: string;
  name: string;
}

/**
 * Смена роли. Дом выбирается здесь же: админу он обязателен, жильцу запрещён —
 * это инвариант базы, и между двумя шагами запись была бы недопустимой.
 */
export function RoleForm({
  currentRole,
  houseId,
  houses,
  userId,
}: {
  currentRole: 'resident' | 'admin' | 'superadmin';
  houseId: string | null;
  houses: readonly HouseOption[];
  userId: string;
}) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(changeRoleAction, INITIAL);
  const [role, setRole] = useState(currentRole);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input name="userId" type="hidden" value={userId} />

      <Field htmlFor="role" label={t('residents.role')}>
        <Select
          id="role"
          name="role"
          onChange={(event) => {
            setRole(event.target.value as 'resident' | 'admin');
          }}
          value={role}
        >
          <option value="resident">{t('residents.roles.resident')}</option>
          <option value="admin">{t('residents.roles.admin')}</option>
        </Select>
      </Field>

      {role === 'admin' && (
        <Field hint={t('residents.houseHint')} htmlFor="house" label={t('residents.house')}>
          <Select defaultValue={houseId ?? ''} id="house" name="houseId" required>
            <option value="">{t('residents.chooseHouse')}</option>
            {houses.map((house) => (
              <option key={house.id} value={house.id}>
                {house.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      )}
      {state.done !== undefined && <p className="text-success text-[13px]">{t(state.done)}</p>}

      <Button data-testid="change-role" disabled={isPending} type="submit" variant="secondary">
        {t('residents.changeRole')}
      </Button>
    </form>
  );
}
