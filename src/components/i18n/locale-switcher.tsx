'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { setLocale } from '@/lib/i18n/actions';
import { isLocale, LOCALES } from '@/lib/i18n/config';

export function LocaleSwitcher() {
  const t = useTranslations('language');
  const current = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (!isLocale(next)) {
      return;
    }

    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <label className="inline-flex items-center gap-2">
      <span className="sr-only">{t('label')}</span>
      <select
        aria-label={t('label')}
        className="h-11 min-w-[7rem] rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[15px] text-[var(--text)] disabled:opacity-60"
        data-testid="locale-switcher"
        disabled={isPending}
        onChange={handleChange}
        value={current}
      >
        {LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {t(locale)}
          </option>
        ))}
      </select>
    </label>
  );
}
