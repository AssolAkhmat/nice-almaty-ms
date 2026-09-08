import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { readChartOfAccounts } from '@/services/chart-of-accounts';

import { AccountsManager, type AccountRow } from './accounts-manager';

export const dynamic = 'force-dynamic';

/**
 * План счетов (модуль 10). Деньги всей сети: экран у суперадмина,
 * а журнал проводок админ по-прежнему видит на своём экране учёта.
 */
export default async function AccountsPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  if (!can(context, 'settings.org.read')) {
    redirect('/settings');
  }

  const t = await getTranslations('chartOfAccounts');
  const accounts = await readChartOfAccounts({ context });

  const rows: AccountRow[] = accounts.map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    houseName: account.houseName,
    isSystem: account.isSystem,
    isArchived: account.isArchived,
    balance: account.balance,
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <AccountsManager canManage={can(context, 'settings.org.write')} rows={rows} />
    </section>
  );
}
