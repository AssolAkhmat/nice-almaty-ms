import { Slot } from '@radix-ui/react-slot';

import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary/90',
  secondary: 'border border-border bg-surface text-text hover:bg-surface-2',
  ghost: 'text-text-muted hover:bg-surface-2 hover:text-text',
  danger: 'bg-danger text-white hover:bg-danger/90',
};

/** На мобильном любая цель нажатия не меньше 44px (docs/05-DESIGN-SYSTEM.md). */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-11 px-3 text-[13px] md:h-9',
  md: 'h-11 px-4 text-[15px]',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Отрисовать как дочерний элемент — например, ссылку. */
  asChild?: boolean;
}

export function Button({
  asChild = false,
  className,
  size = 'md',
  type = 'button',
  variant = 'primary',
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : 'button';

  return (
    <Component
      className={cn(
        'rounded-control inline-flex items-center justify-center gap-2 font-medium transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...(asChild ? {} : { type })}
      {...props}
    />
  );
}
