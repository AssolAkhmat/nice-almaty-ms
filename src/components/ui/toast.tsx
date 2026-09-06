'use client';

import * as ToastPrimitive from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/cn';

export type ToastTone = 'neutral' | 'success' | 'danger';

interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastContextValue {
  show: (message: Omit<ToastMessage, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONES: Record<ToastTone, string> = {
  neutral: 'border-border',
  success: 'border-success',
  danger: 'border-danger',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('common');
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  // Счётчик вместо отметки времени: часы в приложении доступны только через src/lib/time.ts.
  const nextId = useRef(0);

  const show = useCallback((message: Omit<ToastMessage, 'id'>) => {
    nextId.current += 1;
    const id = nextId.current;
    setMessages((current) => [...current, { ...message, id }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);

  return (
    <ToastContext value={value}>
      <ToastPrimitive.Provider duration={6000} swipeDirection="right">
        {children}
        {messages.map((message) => (
          <ToastPrimitive.Root
            className={cn(
              'rounded-card border-border bg-surface flex items-start gap-3 border border-l-2 p-3 shadow-none',
              TONES[message.tone],
            )}
            key={message.id}
            onOpenChange={(open) => {
              if (!open) {
                dismiss(message.id);
              }
            }}
          >
            <div className="flex flex-col gap-0.5">
              <ToastPrimitive.Title className="text-[15px] font-medium">
                {message.title}
              </ToastPrimitive.Title>
              {message.description !== undefined ? (
                <ToastPrimitive.Description className="text-text-muted text-[13px]">
                  {message.description}
                </ToastPrimitive.Description>
              ) : null}
            </div>
            <ToastPrimitive.Close
              aria-label={t('close')}
              className="rounded-control text-text-muted hover:bg-surface-2 hover:text-text ml-auto inline-flex size-8 shrink-0 items-center justify-center"
            >
              <X aria-hidden="true" size={16} strokeWidth={1.5} />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-50 flex w-full max-w-sm flex-col gap-2 p-4" />
      </ToastPrimitive.Provider>
    </ToastContext>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) {
    throw new Error('useToast используется вне ToastProvider');
  }

  return value;
}
