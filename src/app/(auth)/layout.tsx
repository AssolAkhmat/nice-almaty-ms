import { useTranslations } from 'next-intl';

import { LocaleSwitcher } from '@/components/i18n/locale-switcher';
import { ThemeSwitcher } from '@/components/theme/theme-switcher';

/** Незащищённая зона: вход и обязательная смена пароля. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('app');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-border flex h-14 shrink-0 items-center justify-between gap-3 border-b px-3 md:px-4">
        <span className="text-[18px] font-semibold">{t('name')}</span>
        <div className="flex items-center gap-2">
          <ThemeSwitcher />
          <LocaleSwitcher />
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-3 py-8">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
