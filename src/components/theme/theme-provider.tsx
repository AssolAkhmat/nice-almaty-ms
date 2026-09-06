'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';

import {
  DARK_CLASS,
  DARK_MEDIA_QUERY,
  DEFAULT_THEME,
  isTheme,
  resolveIsDark,
  THEME_STORAGE_KEY,
  type Theme,
} from '@/lib/theme';

interface ThemeContextValue {
  /** Выбор пользователя: light, dark или system. */
  theme: Theme;
  /** Фактическое оформление после учёта системной настройки. */
  isDark: boolean;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Своё событие: `storage` срабатывает только в других вкладках. */
const THEME_CHANGE_EVENT = 'nice-almaty:theme-change';

function subscribeToStoredTheme(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);

  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  };
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    // Приватный режим может запрещать чтение.
    return DEFAULT_THEME;
  }
}

function subscribeToSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_MEDIA_QUERY);
  media.addEventListener('change', onChange);

  return () => {
    media.removeEventListener('change', onChange);
  };
}

function readSystemPrefersDark(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // На сервере выбор пользователя неизвестен: класс на <html> уже проставлен
  // скриптом до отрисовки, поэтому серверный снимок нейтральный.
  const theme = useSyncExternalStore(subscribeToStoredTheme, readStoredTheme, () => DEFAULT_THEME);
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemTheme,
    readSystemPrefersDark,
    () => false,
  );

  const isDark = resolveIsDark(theme, systemPrefersDark);

  useEffect(() => {
    document.documentElement.classList.toggle(DARK_CLASS, isDark);
  }, [isDark]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Приватный режим может запрещать запись: выбор не переживёт перезагрузку.
    }

    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, isDark, setTheme }),
    [theme, isDark, setTheme],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error('useTheme используется вне ThemeProvider');
  }

  return value;
}
