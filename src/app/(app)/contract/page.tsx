import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listResidencies } from '@/db/repositories/residencies';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentSession } from '@/lib/session';
import { readProfile } from '@/services/resident-profiles';

import { ContractList, type ContractRowView } from './admin-list';
import { ContractCard } from './contract-view';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Договор (docs/04-MODULES/01-onboarding.md).
 *
 * Жилец видит PDF и подписывает его сам: подпись личная, за него её
 * не ставит никто. Админ собирает договор и отдельно отмечает выдачу
 * ключей — это разные события, и в списке они видны раздельно.
 */
export default async function ContractPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('contract');
  const { context } = session;
  const actor: UserActor = { context };

  const isAdmin = context.role === 'admin' || context.role === 'superadmin';
  const residencies = await listResidencies(context, {});

  if (!isAdmin) {
    const [residency] = residencies;

    return (
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1>{t('title')}</h1>
          <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
        </div>

        {residency === undefined ? (
          <EmptyState description={t('noResidencyHint')} title={t('noResidency')} />
        ) : (
          <ContractCard
            contract={{
              residencyId: residency.id,
              contractFileId: residency.contractFileId,
              isSigned: residency.contractSignedAt !== null,
              keysIssued: residency.keysIssued,
            }}
          />
        )}
      </section>
    );
  }

  const rows: ContractRowView[] = await Promise.all(
    residencies.map(async (residency) => {
      const profile = await readProfile(actor, residency.userId);
      const name = [profile.lastName, profile.firstName]
        .filter((part) => part !== null && part !== '')
        .join(' ');

      return {
        residencyId: residency.id,
        residentName: name.trim() === '' ? residency.userId : name,
        contractFileId: residency.contractFileId,
        isSigned: residency.contractSignedAt !== null,
        keysIssued: residency.keysIssued,
      };
    }),
  );

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('adminSubtitle')}</p>
      </div>

      <ContractList rows={rows} />
    </section>
  );
}
