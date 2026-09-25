import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { listResidencies } from '@/db/repositories/residencies';
import { can } from '@/lib/authz';
import { loadEnv } from '@/lib/env/load';
import { getCurrentSession } from '@/lib/session';
import { personLabels } from '@/services/person-labels';
import { readWelcomeMessage } from '@/services/settings';
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

  /*
   * Подписи людей: ФИО под номером и дом жильца. Дом у жильца живёт
   * в проживании, а не в учётной записи (D11), и колонка, читавшая
   * `users.house_id`, показывала ему прочерк — при том что дом есть
   * и виден в карточке (указание владельца, 25 сентября 2026).
   */
  const labels = await personLabels(
    context,
    accounts.map((account) => account.id),
  );

  const rows: AccountRow[] = accounts.map((account) => ({
    id: account.id,
    phone: account.phone,
    name: labels.get(account.id)?.name ?? null,
    role: account.role,
    houseName: houseNames.get(account.houseId ?? houseOfResident.get(account.id) ?? '') ?? null,
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

  /*
   * Шаблон приветствия: настройка сети, а если её нет — текст из словаря
   * на локали сети. Текст живёт в словарях, а не в коде (указание владельца,
   * 25 сентября 2026).
   */
  const welcomeTemplate =
    (await readWelcomeMessage(context)) ?? (await getTranslations('users.welcome'))('default');

  /* Первая строка сообщения — адрес приложения без схемы. */
  const appHost = new URL(loadEnv().APP_URL).host;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      {can(context, 'user.create') ? (
        <CreateAccountForm
          appHost={appHost}
          houses={houses.map((house) => ({ id: house.id, name: house.name }))}
          welcomeTemplate={welcomeTemplate}
        />
      ) : null}

      <UsersTable rows={rows} />
    </section>
  );
}
