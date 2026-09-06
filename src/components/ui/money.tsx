import { useFormatter } from 'next-intl';

import { cn } from '@/lib/cn';

export interface MoneyProps {
  /** Целое число тенге. Тиынов в системе нет (docs/03-BUSINESS-RULES.md §0). */
  amount: number;
  className?: string;
}

/** Числа и деньги выравниваются вправо моноширинными цифрами. */
export function Money({ amount, className }: MoneyProps) {
  const format = useFormatter();

  return (
    <span className={cn('tabular text-right', amount < 0 && 'text-danger', className)}>
      {format.number(amount, {
        style: 'currency',
        currency: 'KZT',
        maximumFractionDigits: 0,
        minimumFractionDigits: 0,
      })}
    </span>
  );
}
