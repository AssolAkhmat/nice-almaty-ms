'use client';

import { useTranslations } from 'next-intl';

import { AppLink } from '@/components/ui/app-link';
import { Card, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { Table, type TableColumn } from '@/components/ui/table';

import type { HouseRatingRow } from '@/services/rating-views';

/**
 * Рейтинг жильцов дома для админа (модуль 8).
 *
 * Клиентский: колонки таблицы — функции, а их из серверного компонента
 * не передашь. Считает всё сервис, здесь только показ.
 */
export function HouseRatingTable({ rows }: { rows: readonly HouseRatingRow[] }) {
  const t = useTranslations('rating');

  const columns: TableColumn<HouseRatingRow>[] = [
    {
      key: 'name',
      header: t('columns.name'),
      cell: (row) => (
        <AppLink
          className="text-primary hover:underline"
          href={{ pathname: `/rating/${row.userId}` }}
        >
          {row.name}
        </AppLink>
      ),
    },
    {
      key: 'rating',
      header: t('columns.rating'),
      cell: (row) => String(row.rating),
      numeric: true,
    },
    { key: 'debts', header: t('columns.debts'), cell: (row) => String(row.debts), numeric: true },
    {
      key: 'fines',
      header: t('columns.fines'),
      cell: (row) => <Money amount={row.finesPending} />,
      numeric: true,
    },
  ];

  return (
    <Card>
      <CardTitle>{t('house')}</CardTitle>
      <div className="mt-3" data-testid="house-rating">
        <Table caption={t('house')} columns={columns} rowKey={(row) => row.userId} rows={rows} />
      </div>
    </Card>
  );
}
