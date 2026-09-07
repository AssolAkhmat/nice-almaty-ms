'use client';

import { useTranslations } from 'next-intl';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, type TableColumn } from '@/components/ui/table';

/**
 * Своды статистики ротаций (docs/04-MODULES/04-rotation-scoring.md).
 *
 * Клиентский: таблица собирает колонки функциями, а функции из серверного
 * компонента не передаются. Данные приходят готовыми — считает их сервис.
 */
export interface PersonRow {
  userId: string;
  name: string;
  done: number;
  missed: number;
  averageScore: number | null;
}

export interface AreaRow {
  areaId: string;
  name: string;
  averageScore: number | null;
  missRate: number;
}

export interface WeekdayRow {
  weekday: number;
  done: number;
  missed: number;
  averageScore: number | null;
}

export interface MonthRow {
  month: string;
  done: number;
  missed: number;
  averageScore: number | null;
}

export interface StatsViewProps {
  people: readonly PersonRow[];
  areas: readonly AreaRow[];
  weekdays: readonly WeekdayRow[];
  months: readonly MonthRow[];
}

function score(value: number | null): string {
  return value === null ? '—' : String(value);
}

export function StatsView({ areas, months, people, weekdays }: StatsViewProps) {
  const t = useTranslations('rotationStats');

  const personColumns: TableColumn<PersonRow>[] = [
    { key: 'name', header: t('person'), cell: (row) => row.name },
    { key: 'done', header: t('done'), cell: (row) => String(row.done) },
    { key: 'missed', header: t('missed'), cell: (row) => String(row.missed) },
    { key: 'score', header: t('average'), cell: (row) => score(row.averageScore) },
  ];

  const areaColumns: TableColumn<AreaRow>[] = [
    { key: 'name', header: t('area'), cell: (row) => row.name },
    { key: 'score', header: t('average'), cell: (row) => score(row.averageScore) },
    {
      key: 'missRate',
      header: t('missRate'),
      cell: (row) => `${String(Math.round(row.missRate * 100))} %`,
    },
  ];

  const weekdayColumns: TableColumn<WeekdayRow>[] = [
    { key: 'weekday', header: t('weekday'), cell: (row) => t(`weekdays.${String(row.weekday)}`) },
    { key: 'done', header: t('done'), cell: (row) => String(row.done) },
    { key: 'missed', header: t('missed'), cell: (row) => String(row.missed) },
    { key: 'score', header: t('average'), cell: (row) => score(row.averageScore) },
  ];

  const monthColumns: TableColumn<MonthRow>[] = [
    { key: 'month', header: t('month'), cell: (row) => row.month },
    { key: 'done', header: t('done'), cell: (row) => String(row.done) },
    { key: 'missed', header: t('missed'), cell: (row) => String(row.missed) },
    { key: 'score', header: t('average'), cell: (row) => score(row.averageScore) },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('byPerson')}</CardTitle>
        </CardHeader>

        <Table
          caption={t('byPerson')}
          columns={personColumns}
          emptyState={<EmptyState title={t('empty')} />}
          rowKey={(row) => row.userId}
          rows={people}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('byArea')}</CardTitle>
        </CardHeader>

        <Table
          caption={t('byArea')}
          columns={areaColumns}
          emptyState={<EmptyState title={t('empty')} />}
          rowKey={(row) => row.areaId}
          rows={areas}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('byWeekday')}</CardTitle>
        </CardHeader>

        <Table
          caption={t('byWeekday')}
          columns={weekdayColumns}
          emptyState={<EmptyState title={t('empty')} />}
          rowKey={(row) => String(row.weekday)}
          rows={weekdays}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('byMonth')}</CardTitle>
        </CardHeader>

        <Table
          caption={t('byMonth')}
          columns={monthColumns}
          emptyState={<EmptyState title={t('empty')} />}
          rowKey={(row) => row.month}
          rows={months}
        />
      </Card>
    </div>
  );
}
