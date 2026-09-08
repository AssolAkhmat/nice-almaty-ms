'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/cn';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Описание последствий: обязательно для опасных действий. */
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function Modal({
  children,
  className,
  description,
  footer,
  onOpenChange,
  open,
  title,
}: ModalProps) {
  const t = useTranslations('common');

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        {/*
         * Слой выше нижней навигации (z-20): без него на телефоне вкладки
         * перекрывали низ окна, и последний пункт меню «Ещё» уходил под них (T9.10).
         * Тосты остаются выше (z-50): сообщение о результате видно и поверх окна.
         */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-30 bg-black/40" />
        <DialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-40 w-[calc(100vw-2rem)] max-w-[720px] -translate-x-1/2 -translate-y-1/2',
            'rounded-card border-border bg-bg max-h-[calc(100dvh-2rem)] overflow-y-auto border p-4 md:p-6',
            className,
          )}
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <DialogPrimitive.Title className="text-[18px] font-semibold">
                {title}
              </DialogPrimitive.Title>
              {description !== undefined ? (
                <DialogPrimitive.Description className="text-text-muted text-[13px]">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              aria-label={t('close')}
              className="rounded-control text-text-muted hover:bg-surface-2 hover:text-text inline-flex size-11 shrink-0 items-center justify-center transition-colors duration-150"
            >
              <X aria-hidden="true" size={20} strokeWidth={1.5} />
            </DialogPrimitive.Close>
          </div>
          {children}
          {footer !== undefined ? (
            <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
