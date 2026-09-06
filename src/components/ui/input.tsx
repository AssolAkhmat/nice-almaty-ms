import { cn } from '@/lib/cn';

const FIELD_CLASSES =
  'w-full rounded-control border border-border bg-surface px-3 text-[15px] text-text placeholder:text-text-muted disabled:opacity-60 aria-[invalid=true]:border-danger';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD_CLASSES, 'h-11', className)} {...props} />;
}

export function Textarea({
  className,
  rows = 4,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(FIELD_CLASSES, 'py-2 leading-relaxed', className)}
      rows={rows}
      {...props}
    />
  );
}

/**
 * Обёртка над нативным select: на мобильном он открывает системный
 * выбор, что надёжнее и доступнее собственного выпадающего списка.
 */
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(FIELD_CLASSES, 'h-11', className)} {...props} />;
}

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}

/** Поле формы: метка, содержимое, подсказка или ошибка под ним. */
export function Field({ children, error, hint, htmlFor, label }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <p className="text-danger text-[13px]">{error}</p>
      ) : hint !== undefined ? (
        <p className="text-text-muted text-[13px]">{hint}</p>
      ) : null}
    </div>
  );
}
