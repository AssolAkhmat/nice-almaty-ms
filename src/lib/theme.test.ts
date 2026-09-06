import { describe, expect, it } from 'vitest';

import {
  DARK_CLASS,
  DEFAULT_THEME,
  isTheme,
  resolveIsDark,
  THEME_STORAGE_KEY,
  THEMES,
  themeInitScript,
} from './theme';

describe('тема оформления', () => {
  it('три режима, по умолчанию системный', () => {
    expect(THEMES).toEqual(['light', 'dark', 'system']);
    expect(DEFAULT_THEME).toBe('system');
  });

  it('распознаёт только известные режимы', () => {
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('sepia')).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it('светлая и тёмная не зависят от системной настройки', () => {
    expect(resolveIsDark('light', true)).toBe(false);
    expect(resolveIsDark('light', false)).toBe(false);
    expect(resolveIsDark('dark', true)).toBe(true);
    expect(resolveIsDark('dark', false)).toBe(true);
  });

  it('системная следует за настройкой ОС', () => {
    expect(resolveIsDark('system', true)).toBe(true);
    expect(resolveIsDark('system', false)).toBe(false);
  });

  it('скрипт до отрисовки читает то же хранилище и ставит тот же класс', () => {
    const script = themeInitScript();

    expect(script).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(script).toContain(JSON.stringify(DARK_CLASS));
    expect(script).toContain('try');
    expect(script).toContain('catch');
  });
});
