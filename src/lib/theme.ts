/**
 * Тема оформления: светлая, тёмная, системная (docs/05-DESIGN-SYSTEM.md).
 * В фазе 0 выбор хранится только в localStorage; синхронизация с профилем
 * пользователя появится в фазе 1 (docs/08-DECISIONS.md, P0-7).
 */
export const THEMES = ['light', 'dark', 'system'] as const;

export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'system';

export const THEME_STORAGE_KEY = 'nice-almaty-theme';

/** Класс на <html>, которым Tailwind переключает тёмную тему. */
export const DARK_CLASS = 'dark';

export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && THEMES.includes(value as Theme);
}

/** Чистое правило: применять ли тёмное оформление. */
export function resolveIsDark(theme: Theme, systemPrefersDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemPrefersDark);
}

/**
 * Скрипт, исполняемый до первой отрисовки: ставит класс на <html>,
 * чтобы страница не мигала светлой темой у тех, кто выбрал тёмную.
 * Ошибки проглатываются: приватный режим может запрещать localStorage.
 */
export function themeInitScript(): string {
  return [
    '(function(){try{',
    `var stored=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});`,
    `var prefersDark=window.matchMedia(${JSON.stringify(DARK_MEDIA_QUERY)}).matches;`,
    "var isDark=stored==='dark'||((stored===null||stored==='system')&&prefersDark);",
    `document.documentElement.classList.toggle(${JSON.stringify(DARK_CLASS)},isDark);`,
    '}catch(e){}})();',
  ].join('');
}
