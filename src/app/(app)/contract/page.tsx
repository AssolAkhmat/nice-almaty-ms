import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listResidencies } from '@/db/repositories/residencies';
import { EmptyState } from '@/components/ui/empty-state';
import { can } from '@/lib/authz';
import { personLabels } from '@/services/person-labels';
import { getCurrentSession } from '@/lib/session';

import { ContractList, type ContractRowView } from './admin-list';
import { ContractCard } from './contract-view';

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

  /*
   * Вместо человека в списке стоял uuid проживания: понять, кто не заполнил
   * профиль и кто не подписал, было нельзя (указание владельца, 25 сентября
   * 2026). Подпись теперь общая для всех экранов — ФИО, а без профиля
   * телефон с пометкой.
   */
  const labels = await personLabels(
    context,
    residencies.map((residency) => residency.userId),
  );

  const rows: ContractRowView[] = residencies.map((residency) => {
    const label = labels.get(residency.userId);

    return {
      residencyId: residency.id,
      resident: { name: label?.name ?? null, phone: label?.phone ?? '' },
      contractFileId: residency.contractFileId,
      isSigned: residency.contractSignedAt !== null,
      keysIssued: residency.keysIssued,
    };
  });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('adminSubtitle')}</p>
      </div>

      <ContractList
        canRead={can(context, 'contract.read', { houseId: context.houseId })}
        rows={rows}
      />
    </section>
  );
}
