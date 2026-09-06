'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from './button';

export interface PaginationProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ onPageChange, page, pageCount }: PaginationProps) {
  const t = useTranslations('common');

  if (pageCount <= 1) {
    return null;
  }

  return (
    <nav aria-label={t('pagination')} className="flex items-center justify-between gap-3">
      <Button
        aria-label={t('previous')}
        disabled={page <= 1}
        onClick={() => {
          onPageChange(page - 1);
        }}
        size="sm"
        variant="secondary"
      >
        <ChevronLeft aria-hidden="true" size={16} strokeWidth={1.5} />
        <span className="hidden sm:inline">{t('previous')}</span>
      </Button>

      <span className="tabular text-text-muted text-[13px]">
        {t('pageOf', { page, pageCount })}
      </span>

      <Button
        aria-label={t('next')}
        disabled={page >= pageCount}
        onClick={() => {
          onPageChange(page + 1);
        }}
        size="sm"
        variant="secondary"
      >
        <span className="hidden sm:inline">{t('next')}</span>
        <ChevronRight aria-hidden="true" size={16} strokeWidth={1.5} />
      </Button>
    </nav>
  );
}
