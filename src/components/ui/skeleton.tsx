import { cn } from '@/lib/cn';

/** Заглушка на время загрузки. Анимация короткая и однотонная. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('rounded-control bg-surface-2 animate-pulse', className)}
      {...props}
    />
  );
}
