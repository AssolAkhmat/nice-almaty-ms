import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-border bg-surface-2 text-text-muted',
  info: 'border-primary/30 bg-primary/10 text-primary',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
  /* Единственный допустимый способ использовать жёлтый как заливку:
     маленький бейдж с почти чёрным текстом (docs/05-DESIGN-SYSTEM.md). */
  accent: 'border-transparent bg-accent text-accent-fg',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[13px] font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

/**
 * Цветовой код статусов из docs/05-DESIGN-SYSTEM.md.
 * Смысл дублируется текстом: цвет не единственный носитель информации.
 */
export type StatusKind = 'done' | 'neutral' | 'attention' | 'problem' | 'muted';

const STATUS_TONES: Record<StatusKind, BadgeTone> = {
  done: 'success',
  neutral: 'neutral',
  attention: 'accent',
  problem: 'danger',
  muted: 'neutral',
};

export interface StatusPillProps {
  kind: StatusKind;
  children: React.ReactNode;
  className?: string;
}

export function StatusPill({ children, className, kind }: StatusPillProps) {
  return (
    <Badge className={cn(kind === 'muted' && 'opacity-70', className)} tone={STATUS_TONES[kind]}>
      {children}
    </Badge>
  );
}
