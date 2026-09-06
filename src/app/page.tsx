import { useTranslations } from 'next-intl';

import { LocaleSwitcher } from '@/components/i18n/locale-switcher';
import { ThemeSwitcher } from '@/components/theme/theme-switcher';

export default function HomePage() {
  const t = useTranslations('home');

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-4 px-4 py-10">
      <h1>{t('title')}</h1>
      <p className="text-[var(--text-muted)]">{t('subtitle')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <ThemeSwitcher />
        <LocaleSwitcher />
      </div>
    </main>
  );
}
