import { useTranslations } from 'next-intl';

import { LocaleSwitcher } from '@/components/i18n/locale-switcher';
import { ThemeSwitcher } from '@/components/theme/theme-switcher';

import { BottomNav } from './bottom-nav';
import { Sidebar } from './sidebar';

function Header() {
  const t = useTranslations('app');

  return (
    <header className="border-border bg-bg flex h-14 shrink-0 items-center justify-between gap-3 border-b px-3 md:px-4">
      <span className="text-[18px] font-semibold">{t('name')}</span>
      <div className="flex items-center gap-2">
        <ThemeSwitcher />
        <LocaleSwitcher />
      </div>
    </header>
  );
}

/**
 * Каркас защищённой зоны (docs/05-DESIGN-SYSTEM.md, «Сетка и адаптивность»).
 * Проверка прав появится в фазе 1: сейчас это только раскладка.
 */
export function AppShell({
  children,
  unread = 0,
}: {
  children: React.ReactNode;
  /** Непрочитанные уведомления адресата: считает защищённая зона. */
  unread?: number;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <div className="flex flex-1">
        <Sidebar unread={unread} />
        <main className="min-w-0 flex-1 px-3 py-4 md:px-6 md:py-6">{children}</main>
      </div>
      <BottomNav unread={unread} />
    </div>
  );
}
