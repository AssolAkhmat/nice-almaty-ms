'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { THEMES, type Theme } from '@/lib/theme';

import { useTheme } from './theme-provider';

const ICONS: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export function ThemeSwitcher() {
  const t = useTranslations('theme');
  const { theme, setTheme } = useTheme();

  return (
    <div
      aria-label={t('label')}
      className="inline-flex rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] p-0.5"
      role="group"
    >
      {THEMES.map((option) => {
        const Icon = ICONS[option];
        const isActive = theme === option;

        return (
          <button
            aria-label={t(option)}
            aria-pressed={isActive}
            className={[
              'inline-flex h-10 w-11 items-center justify-center rounded-[6px] transition-colors duration-150',
              isActive
                ? 'bg-[var(--primary)] text-[var(--primary-fg)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
            ].join(' ')}
            data-testid={`theme-${option}`}
            key={option}
            onClick={() => {
              setTheme(option);
            }}
            title={t(option)}
            type="button"
          >
            <Icon aria-hidden="true" size={20} strokeWidth={1.5} />
          </button>
        );
      })}
    </div>
  );
}
