import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { listResidencies } from '@/db/repositories/residencies';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { listAccounts } from '@/services/users';

import { CreateAccountForm } from './create-account-form';
import { UsersTable, type AccountRow } from './users-table';

export const dynamic = 'force-dynamic';

/**
 * Список учётных записей (docs/04-MODULES/11-users-settings.md).
 * ФИО появится в фазе 2 вместе с профилем жильца: в фазе 1 его негде взять.
 */
export default async function UsersPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('users');
  const { context } = session;

  const [accounts, houses, residencies] = await Promise.all([
    listAccounts({ context }),
    listHouses(context, {}),
    listResidencies(context, {}),
  ]);

  const houseNames = new Map(houses.map((house) => [house.id, house.name]));
  const withResidency = new Set(residencies.map((residency) => residency.userId));
  const houseOfResident = new Map(
    residencies.map((residency) => [residency.userId, residency.houseId]),
  );
  /*
   * Проживание заводится вместе с учётной записью (P9-3); кнопка нужна
   * только записям старше этого правила — админам без проживания, которым
   * иначе не назначить место. Право то же, что на создание учётной записи.
   */
  const canOpenResidency = can(context, 'user.create');

  const rows: AccountRow[] = accounts.map((account) => ({
    id: account.id,
    phone: account.phone,
    role: account.role,
    houseName: account.houseId === null ? null : (houseNames.get(account.houseId) ?? null),
    status: account.status,
    lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
    isSelf: account.id === context.userId,
    canAllowReset: can(context, 'user.allowPasswordReset', {
      houseId: account.houseId,
      userId: account.id,
    }),
    canArchive: can(context, 'user.archive', { houseId: account.houseId, userId: account.id }),
    canOpenResidency:
      canOpenResidency &&
      account.role === 'admin' &&
      account.status === 'active' &&
      !withResidency.has(account.id),
    /*
     * Чужой номер меняют суперадмин и админ своего дома; свой — в личных
     * настройках, с паролем. Дом жильца — в проживании, поэтому право
     * проверяется по нему, как и в сервисе (T9.7).
     */
    canChangePhone:
      account.id !== context.userId &&
      account.status === 'active' &&
      can(context, 'user.changePhone', {
        houseId: account.houseId ?? houseOfResident.get(account.id) ?? null,
        userId: account.id,
      }),
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      {can(context, 'user.create') ? (
        <CreateAccountForm houses={houses.map((house) => ({ id: house.id, name: house.name }))} />
      ) : null}

      <UsersTable rows={rows} />
    </section>
  );
}
