'use client';

import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { logoutAction } from '@/app/(auth)/actions';
import { cn } from '@/lib/cn';

/**
 * Выход из системы (T9.6). Обычная форма с server action: сессия отзывается
 * на сервере и попадает в журнал, cookie снимается там же.
 *
 * Живёт в навигации, а не в шапке: на 375 шапка занята темой и языком,
 * и пятому элементу там уже не хватает ширины.
 */
export function LogoutButton({
  className,
  labelClassName,
  onDone,
}: {
  className?: string;
  /** Подпись: в свёрнутом меню планшета прячется, остаётся значок и `title`. */
  labelClassName?: string;
  onDone?: () => void;
}) {
  const t = useTranslations('auth');

  return (
    <form action={logoutAction} onSubmit={onDone}>
      <button
        className={cn(
          'rounded-control text-text-muted hover:bg-surface-2 hover:text-text flex h-11 w-full items-center gap-3 px-3 text-[15px] transition-colors duration-150',
          className,
        )}
        data-testid="logout"
        title={t('signOut')}
        type="submit"
      >
        <LogOut aria-hidden="true" className="shrink-0" size={20} strokeWidth={1.5} />
        <span className={labelClassName}>{t('signOut')}</span>
      </button>
    </form>
  );
}
