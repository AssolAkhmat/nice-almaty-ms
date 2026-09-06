import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Действие, которое выводит из пустого состояния. */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ action, className, description, title }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'rounded-card border-border flex flex-col items-center gap-2 border border-dashed px-4 py-10 text-center',
        className,
      )}
    >
      <p className="font-medium">{title}</p>
      {description !== undefined ? (
        <p className="text-text-muted max-w-prose text-[13px]">{description}</p>
      ) : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
