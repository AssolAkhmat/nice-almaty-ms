'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/cn';

export interface TableColumn<Row> {
  key: string;
  header: string;
  /** Содержимое ячейки. */
  cell: (row: Row) => React.ReactNode;
  sortable?: boolean;
  /** Числовые колонки выравниваются вправо. */
  numeric?: boolean;
}

export type SortDirection = 'asc' | 'desc';

export interface TableSort {
  key: string;
  direction: SortDirection;
}

export interface TableProps<Row> {
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  caption: string;
  sort?: TableSort;
  onSortChange?: (sort: TableSort) => void;
  /** Подсветка выбранной строки. */
  isHighlighted?: (row: Row) => boolean;
  emptyState?: React.ReactNode;
}

/**
 * Таблица с липкой шапкой и сортировкой. Уже 768px строки превращаются
 * в карточки: на телефоне горизонтальная прокрутка недопустима
 * (docs/05-DESIGN-SYSTEM.md, «Сетка и адаптивность»).
 */
export function Table<Row>({
  caption,
  columns,
  emptyState,
  isHighlighted,
  onSortChange,
  rowKey,
  rows,
  sort,
}: TableProps<Row>) {
  const t = useTranslations('common');

  if (rows.length === 0 && emptyState !== undefined) {
    return emptyState;
  }

  function toggleSort(key: string) {
    if (onSortChange === undefined) {
      return;
    }

    const direction: SortDirection = sort?.key === key && sort.direction === 'asc' ? 'desc' : 'asc';
    onSortChange({ key, direction });
  }

  return (
    <>
      {/* Мобильная раскладка: одна карточка на строку. */}
      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <li
            className={cn(
              'rounded-card border-border bg-surface border p-3',
              isHighlighted?.(row) === true && 'border-primary',
            )}
            key={rowKey(row)}
          >
            <dl className="flex flex-col gap-1.5">
              {columns.map((column) => (
                <div className="flex items-baseline justify-between gap-3" key={column.key}>
                  <dt className="text-label">{column.header}</dt>
                  <dd className={cn('text-[15px]', column.numeric === true && 'tabular')}>
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-[15px]">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-bg sticky top-0 z-10">
            <tr>
              {columns.map((column) => {
                const isSorted = sort?.key === column.key;

                return (
                  <th
                    aria-sort={
                      isSorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={cn(
                      'border-border border-b px-3 py-2 text-left',
                      column.numeric === true && 'text-right',
                    )}
                    key={column.key}
                    scope="col"
                  >
                    {column.sortable === true && onSortChange !== undefined ? (
                      <button
                        className="text-label hover:text-text inline-flex items-center gap-1"
                        onClick={() => {
                          toggleSort(column.key);
                        }}
                        title={isSorted && sort.direction === 'asc' ? t('sortDesc') : t('sortAsc')}
                        type="button"
                      >
                        {column.header}
                        {isSorted ? (
                          sort.direction === 'asc' ? (
                            <ChevronUp aria-hidden="true" size={16} strokeWidth={1.5} />
                          ) : (
                            <ChevronDown aria-hidden="true" size={16} strokeWidth={1.5} />
                          )
                        ) : null}
                      </button>
                    ) : (
                      <span className="text-label">{column.header}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                className={cn(
                  'border-border border-b last:border-b-0',
                  isHighlighted?.(row) === true && 'bg-primary/5',
                )}
                key={rowKey(row)}
              >
                {columns.map((column) => (
                  <td
                    className={cn('px-3 py-2', column.numeric === true && 'tabular text-right')}
                    key={column.key}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
