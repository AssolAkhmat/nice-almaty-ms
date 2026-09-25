import { cn } from '@/lib/cn';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-card border-border bg-surface border p-4', className)} {...props} />
  );
}

/**
 * Шапка карточки. Перенос обязателен: заголовок рядом с бейджем на телефоне
 * не помещался в строку и распирал карточку шире экрана — страница получала
 * горизонтальную прокрутку, а нижняя панель переставала доходить до края
 * (отзыв владельца, 25 сентября 2026).
 */
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mb-3 flex flex-wrap items-center justify-between gap-3', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  /* `min-w-0` и перенос по словам: длинное название не должно распирать ряд. */
  return (
    <h3 className={cn('min-w-0 text-[18px] font-semibold break-words', className)} {...props} />
  );
}
