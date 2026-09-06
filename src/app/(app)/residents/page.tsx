import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { listAreas } from '@/db/repositories/areas';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { Button } from '@/components/ui/button';
import { getCurrentSession } from '@/lib/session';
import { listHouseResidents, type ResidentFilter } from '@/services/residents';

import type { Residency } from '@/db/schema';
import type { Route } from 'next';
import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

const STATUSES: readonly Residency['status'][] = [
  'created',
  'profile_pending',
  'docs_pending',
  'deposit_pending',
  'active',
  'terminating',
  'archived',
];

/**
 * Список жильцов дома (docs/04-MODULES/01-onboarding.md).
 *
 * Фильтры идут параметрами адреса, а не состоянием на клиенте: ссылку
 * на отфильтрованный список можно переслать, и она откроется так же.
 */
export default async function ResidentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('residents');
  const { context } = session;
  const actor: UserActor = { context };

  const params = await searchParams;
  const single = (key: string): string => (typeof params[key] === 'string' ? params[key] : '');

  const status = STATUSES.find((candidate) => candidate === single('status'));
  const filter: ResidentFilter = {
    ...(status === undefined ? {} : { status }),
    ...(single('area') === '' ? {} : { areaId: single('area') }),
    ...(single('debt') === '1' ? { withDebt: true } : {}),
    ...(single('docs') === '1' ? { withDocumentProblems: true } : {}),
    ...(single('q') === '' ? {} : { query: single('q') }),
  };

  const rows = await listHouseResidents(actor, filter);
  const areas = context.houseId === null ? [] : await listAreas(context, context.houseId);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <form className="grid gap-3 md:grid-cols-5" method="get">
        <Field htmlFor="filter-q" label={t('search')}>
          <Input defaultValue={single('q')} id="filter-q" name="q" type="search" />
        </Field>

        <Field htmlFor="filter-status" label={t('status')}>
          <Select defaultValue={single('status')} id="filter-status" name="status">
            <option value="">{t('any')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`statuses.${value}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field htmlFor="filter-area" label={t('room')}>
          <Select defaultValue={single('area')} id="filter-area" name="area">
            <option value="">{t('any')}</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field htmlFor="filter-debt" label={t('debt')}>
          <Select defaultValue={single('debt')} id="filter-debt" name="debt">
            <option value="">{t('any')}</option>
            <option value="1">{t('withDebt')}</option>
          </Select>
        </Field>

        <Field htmlFor="filter-docs" label={t('documents')}>
          <Select defaultValue={single('docs')} id="filter-docs" name="docs">
            <option value="">{t('any')}</option>
            <option value="1">{t('withDocumentProblems')}</option>
          </Select>
        </Field>

        <Button className="md:col-span-5 md:w-fit" type="submit" variant="secondary">
          {t('apply')}
        </Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState description={t('emptyHint')} title={t('empty')} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((row) => (
            <Card data-testid="resident-row" key={row.residencyId}>
              <CardHeader>
                <CardTitle>
                  <Link
                    className="underline-offset-2 hover:underline"
                    href={`/residents/${row.residencyId}` as Route}
                  >
                    {row.fullName}
                  </Link>
                </CardTitle>
                <Badge tone={row.status === 'active' ? 'success' : 'neutral'}>
                  {t(`statuses.${row.status}`)}
                </Badge>
              </CardHeader>

              <div className="flex flex-col gap-1 p-4 pt-0 text-[13px]">
                <span className="text-text-muted">
                  {row.room === null ? t('noRoom') : `${row.room}, ${row.bed ?? ''}`}
                </span>

                {row.price !== null && <Money amount={row.price} className="self-start" />}

                <span className="flex gap-2">
                  {row.hasDebt && <Badge tone="danger">{t('debtMark')}</Badge>}
                  {row.hasDocumentProblem && <Badge tone="warning">{t('documentsMark')}</Badge>}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
