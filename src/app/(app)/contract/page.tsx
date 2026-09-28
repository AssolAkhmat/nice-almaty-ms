import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { AppLink } from '@/components/ui/app-link';
import { listHouses } from '@/db/repositories/houses';
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
export default async function ContractPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('contract');
  const tc = await getTranslations('common');
  const { context } = session;

  const isAdmin = context.role === 'admin' || context.role === 'superadmin';

  /*
   * Фильтр по дому (находка P2-9, 27 сентября 2026): у суперадмина список
   * договоров был общим на всю сеть, одним полотном без разбора по домам.
   */
  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const { house: requestedHouse } = await searchParams;
  const houseId = houses.some((house) => house.id === requestedHouse) ? requestedHouse : undefined;

  const residencies = await listResidencies(context, houseId === undefined ? {} : { houseId });

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

      {houses.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-[13px]" data-testid="contract-houses">
          <AppLink
            className={
              houseId === undefined ? 'text-text font-medium' : 'text-text-muted hover:text-text'
            }
            href="/contract"
          >
            {tc('allHouses')}
          </AppLink>
          {houses.map((house) => (
            <AppLink
              className={
                house.id === houseId ? 'text-text font-medium' : 'text-text-muted hover:text-text'
              }
              href={{ pathname: '/contract', query: { house: house.id } }}
              key={house.id}
            >
              {house.name}
            </AppLink>
          ))}
        </nav>
      )}

      <ContractList
        canRead={can(context, 'contract.read', { houseId: context.houseId })}
        rows={rows}
      />
    </section>
  );
}
